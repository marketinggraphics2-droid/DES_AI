/* DES admin dashboard · vanilla JS, served by the backend at /admin. Data comes from /api/admin/* (signed-in user; what is shown depends on the role).
   Layout rules: no data tables. Every list is cards or rows with a clear title / meta / action, and lists get the shared filter bar. */
(() => {
  'use strict';

  // ---------------- basics ----------------
  // Optional parts are passed as null / false (e.g. `cond ? node : null`); the DOM would print them as the text "null".
  // On this page replaceChildren / append skip them, the same way h() does.
  for (const m of ['replaceChildren', 'append']) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
  }
  const $ = (s, r = document) => r.querySelector(s);
  const main = $('#main'), layer = $('#layer');
  const GENERAL = 'General';
  const LEAD_STATUSES = ['new', 'contacted', 'call_again', 'qualified', 'not_interested']; // every sign-up is a lead; status = result of the last call
  const state = { status: null, products: [], days: 30, me: null, perms: new Set() };
  /** The server enforces every permission; this only hides what the signed-in role can't use. */
  const can = (p) => state.perms.has(p);
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };

  /** h('div', {class, text, on:{click}, ...attrs}, ...children) — never parses HTML unless `html` is passed (trusted/escaped only). */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /** Same light-markdown renderer as the widget: escape first, then bold / italic / lists / links. */
  function fmt(raw) {
    const inline = (s) => esc(s)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)(?=[.,!?;:]?(?:[\s)]|$))/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const out = []; let list = null, para = [];
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    for (const line of String(raw || '').split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) { flushPara(); const tag = ul ? 'ul' : 'ol'; if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; } list.items.push(inline((ul || ol)[1])); }
      else if (!line.trim()) { flushList(); flushPara(); }
      else { flushList(); para.push(inline(line)); }
    }
    flushList(); flushPara();
    return out.join('');
  }
  const nf = new Intl.NumberFormat('en-PH');
  const n = (v) => nf.format(Number(v) || 0);
  const usd = (v) => '$' + (Number(v) || 0).toFixed(Number(v) < 1 ? 3 : 2);
  const dtf = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
  const dayf = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const when = (iso) => (iso ? dtf.format(new Date(iso)) : '—');
  function ago(iso) {
    if (!iso) return '—';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return when(iso);
  }
  /** "in 3 days" / "in 5 h" until a future time. */
  function untilText(iso) {
    const s = (new Date(iso).getTime() - Date.now()) / 1000;
    if (s <= 0) return 'expired';
    if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
    if (s < 86400) return `in ${Math.round(s / 3600)} h`;
    return `in ${Math.round(s / 86400)} days`;
  }
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 80)); } return false; };
  const shortPath = (url) => { try { const u = new URL(url); return (u.pathname + u.search).replace(/\/$/, '') || '/'; } catch { return String(url || ''); } };
  const plural = (k, one, many = one + 's') => `${n(k)} ${k === 1 ? one : many}`;
  /** Typing in a field? Then single-key shortcuts stay off. */
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  // ---------------- feedback: toasts, confirm, copy ----------------
  /** toast('Saved') · toast('Failed', true) · toast('Status changed', false, { undo: async () => … }) shows an Undo button for 7 s. */
  function toast(msg, bad = false, { undo } = {}) {
    document.querySelectorAll('.toast').forEach((x) => x.remove()); // one at a time, so they never pile up
    const t = h('div', { class: 'toast' + (bad ? ' is-bad' : ''), role: 'status' }, h('span', { text: msg }));
    let timer = null;
    if (undo) t.append(h('button', { class: 'toast__undo', type: 'button', text: 'Undo', on: { click: async () => {
      clearTimeout(timer); t.remove();
      try { await undo(); toast('Undone'); } catch (e) { fail(e); }
    } } }));
    document.body.append(t); timer = setTimeout(() => t.remove(), undo ? 7000 : bad ? 5000 : 2600);
  }
  /** Confirmation dialog (replaces the browser's confirm()): resolves true / false. Cancel has focus, so Enter never confirms by accident. */
  function ask(text, { title = 'Are you sure?', ok = 'Continue', danger = true } = {}) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const done = (v) => { holder.remove(); prev?.focus?.({ preventScroll: true }); resolve(v); };
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel', on: { click: () => done(false) } });
      const holder = h('div', { class: 'modal modal--confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title,
        on: { keydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } } } },
        h('div', { class: 'scrim', on: { click: () => done(false) } }),
        h('div', { class: 'modal__card', style: { width: 'min(440px, 100%)' } },
          h('div', { class: 'modal__head' }, h('h2', { text: title })),
          h('div', { class: 'modal__body' }, h('p', { style: { margin: 0 }, text })),
          h('div', { class: 'modal__foot' }, cancel, h('button', { class: 'btn ' + (danger ? 'btn--danger-solid' : 'btn--primary'), type: 'button', text: ok, on: { click: () => done(true) } }))));
      document.body.append(holder); cancel.focus();
    });
  }
  async function copyText(text, msg = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Could not copy. Select the text and press Ctrl + C.', true); }
  }
  /** Temporary password: 14 characters without look-alikes (0/O, 1/l/I). */
  function genPassword() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.getRandomValues(new Uint32Array(14)), (x) => a[x % a.length]).join('');
  }
  /** Password field with Generate and Copy, pre-filled with a generated password. */
  function passwordField(label) {
    const input = h('input', { class: 'input mono', type: 'text', autocomplete: 'new-password', spellcheck: false, minLength: 10, required: true, 'aria-label': label, value: genPassword() });
    return { input, el: h('div', { class: 'field' }, h('span', { text: label }),
      h('div', { class: 'pw-row' }, input,
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Generate', on: { click: () => { input.value = genPassword(); input.focus(); } } }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Copy', on: { click: () => copyText(input.value, 'Password copied') } })),
      h('small', { text: 'At least 10 characters. Send it to them privately and ask them to change it after signing in.' })) };
  }

  // ---- inactivity: the person's own clicks / keys / scrolls count as use; background refreshes don't ----
  let lastActivity = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll']) document.addEventListener(ev, () => { lastActivity = Date.now(); idleWarned = false; document.querySelector('.idle-warning')?.remove(); }, { passive: true, capture: true });
  let idleTimer = null, idleWarned = false;
  function watchIdle(session) {
    clearInterval(idleTimer);
    if (!session || session.remember || !session.idle_minutes) return;
    const limit = session.idle_minutes * 60e3;
    idleTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle >= limit) { clearInterval(idleTimer); signOut(`Signed out after ${session.idle_minutes} minutes without activity. Sign in again to continue.`); }
      else if (idle >= limit - 60e3 && !idleWarned) {
        idleWarned = true;
        document.body.append(h('div', { class: 'idle-warning', role: 'alert' }, h('b', { text: 'Still there?' }), ' You will be signed out in 1 minute. Move the mouse or press a key to stay signed in.'));
      }
    }, 5000);
  }

  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const r = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      // x-des-admin: changes need a header a form on another website can't send
      headers: { 'x-des-idle-ms': String(Date.now() - lastActivity), ...(method !== 'GET' ? { 'x-des-admin': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      const why = (await r.clone().json().catch(() => ({}))).error;
      showLogin(why === 'session_timeout' ? 'Signed out after a while without activity. Sign in again to continue.' : 'Your sign-in expired. Sign in again.');
      throw new Error('unauthorized');
    }
    if (r.status === 403) throw new Error('Your role can’t do that.');
    if (!r.ok) { let msg = `Request failed (${r.status})`; try { const j = await r.json(); msg = j.message || (j.error ? j.error.replace(/_/g, ' ') : msg); } catch { } throw new Error(msg); }
    return raw ? r : r.json();
  }
  const fail = (e) => { if (e.message !== 'unauthorized') toast(e.message || 'Something went wrong', true); };
  const setLeadStatus = (leadId, status) => api('/admin/leads/' + leadId, { method: 'PUT', body: { status } });

  // ---------------- address: #/page/arg?filters ----------------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw, query = qi >= 0 ? raw.slice(qi + 1) : '';
    const [page, ...rest] = path.split('/');
    return { page: page || 'overview', arg: rest.length ? decodeURIComponent(rest.join('/')) : null, query: new URLSearchParams(query) };
  }
  /** Rewrite the filters in the address without reloading the page (bookmarkable views). */
  function setQuery(params) {
    const { page, arg } = parseHash(); const qs = params.toString();
    history.replaceState(null, '', `#/${page}${arg ? '/' + encodeURIComponent(arg) : ''}${qs ? '?' + qs : ''}`);
  }
  const currentPage = () => parseHash().page;

  // ---------------- live updates (Server-Sent Events from /api/admin/stream) ----------------
  // The browser reconnects by itself and sends Last-Event-ID; the server replays what was missed or says "resync".
  const live = { es: null, wait: 1000, lastId: '', active: new Set(), page: null, drawer: null };
  function setLivePill(on) { const p = $('#livePill'); if (p) { p.textContent = on ? 'Live' : 'Reconnecting…'; p.classList.toggle('is-off', !on); } }
  function dispatch(type, d) { try { live.drawer?.(type, d); } catch (e) { console.error(e); } try { live.page?.(type, d); } catch (e) { console.error(e); } }
  function disconnectLive() { live.es?.close(); live.es = null; }
  function connectLive() {
    disconnectLive();
    if (typeof EventSource !== 'function') return;
    const es = new EventSource('/api/admin/stream' + (live.lastId ? '?last_event_id=' + encodeURIComponent(live.lastId) : ''));
    live.es = es;
    es.onopen = () => { live.wait = 1000; setLivePill(true); };
    es.onerror = async () => {
      setLivePill(false);
      if (es.readyState !== 2) return; // still CONNECTING: the browser retries on its own
      // closed for good (signed out, server restarted…): check the sign-in, then reconnect with a growing delay
      try { await api('/admin/auth/me'); } catch { return; }
      setTimeout(() => { if (live.es === es) connectLive(); }, live.wait); live.wait = Math.min(30000, live.wait * 2);
    };
    const on = (type, fn) => es.addEventListener(type, (e) => { if (e.lastEventId) live.lastId = e.lastEventId; let d = {}; try { d = JSON.parse(e.data); } catch { } fn(d, type); });
    on('hello', (d) => { live.active = new Set(d.active || []); dispatch('presence', {}); });
    on('resync', () => { route(); refreshReviewCount(); });
    on('presence', (d) => { if (d.active) live.active.add(d.conversation_id); else live.active.delete(d.conversation_id); dispatch('presence', d); });
    on('review.count', () => refreshReviewCount());
    on('overview.tick', () => { if (currentPage() === 'overview' && !layer.childElementCount) pageOverview({ silent: true }); renderStatus(); });
    for (const t of ['conversation.new', 'conversation.update', 'message.new', 'lead.update', 'typing', 'remark.new', 'remark.deleted']) on(t, (d) => dispatch(t, d));
  }

  // ---------------- labels, badges, chips ----------------
  const BLOCK_LABELS = {
    injection: 'Tried to override the bot’s instructions', off_topic: 'Off-topic question', price: 'Asked for pricing (redirected to demo)',
    abuse: 'Abusive message', support: 'Support request (sent to helpdesk)', too_long: 'Message too long', budget: 'Daily AI budget reached',
    turn_cap: 'Chat too long', contact_echo: 'Reply repeated visitor contact', prompt_leak: 'Reply leaked instructions',
  };
  const blockLabel = (r) => String(r || '').split(',').map((x) => BLOCK_LABELS[x] || x.replace(/_/g, ' ')).join(', ');
  const STATUS_BADGE = { open: ['Open', ''], closed: ['Chat closed', ''], ended: ['Ended by DES (off-topic)', 'badge--bad'] };
  const statusBadge = (s) => { const [t, c] = STATUS_BADGE[s] || [s, '']; return h('span', { class: 'badge ' + c, text: t }); };
  const badge = (text, cls = '') => h('span', { class: 'badge ' + cls, text });
  /** Line icons (24 px grid, 2 px stroke, same style as the menu icons). */
  const ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    flag: '<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>',
    forward: '<path d="M15 17l5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    up: '<path d="M7 10v11"/><path d="M15 5.9L14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H7V10l4-8a3 3 0 0 1 4 3.9z"/>',
    down: '<path d="M17 14V3"/><path d="M9 18.1L10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3H17v11l-4 8a3 3 0 0 1-4-3.9z"/>',
    star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    circle: '<circle cx="12" cy="12" r="5"/>',
    square: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    dot: '<circle cx="12" cy="12" r="1"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  };
  function icon(name, cls = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: ('ico ' + cls).trim() })) svg.setAttribute(k, v);
    svg.innerHTML = ICONS[name] || ICONS.dot;
    return svg;
  }
  /** Badge with a leading icon. */
  const ibadge = (name, text, cls = '') => h('span', { class: 'badge ' + cls }, icon(name), text);
  const CONTACT_LABEL = { work_email: 'Work email', email: 'Personal email', mobile: 'Mobile', landline: 'Landline', viber: 'Viber', whatsapp: 'WhatsApp', wechat: 'WeChat', telegram: 'Telegram', signal: 'Signal', line: 'LINE' };
  const contactBadge = (type) => type && type !== 'mobile' ? badge(CONTACT_LABEL[type] || type, type === 'work_email' ? 'badge--good' : '') : null;
  const priceLike = (s) => /₱|\bPHP\s?\d|\bP\s?\d{1,3}(,\d{3})+|\b\d{1,3}(,\d{3})+(\.\d+)?\s?(pesos|php)\b/i.test(s || '');
  /** Call result: colour + icon + label (never colour alone). Not called yet blue · Call again amber · Qualified green · Not interested grey. */
  const LEAD_META = { new: ['Not called yet', 'circle'], contacted: ['Contacted', 'chat'], call_again: ['Call again', 'phone'], qualified: ['Qualified', 'check'], not_interested: ['Not interested', 'x'] };
  const leadName = (st) => LEAD_META[st]?.[0] || st;
  const leadBadge = (st) => st ? h('span', { class: 'lbadge lbadge--' + st }, icon(LEAD_META[st]?.[1] || 'dot'), leadName(st)) : null;
  const hashOf = (s) => { let x = 7; for (const c of String(s || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
  const initials = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const avatar = (name, cls = '') => h('span', { class: 'avatar ' + cls, 'aria-hidden': 'true', 'data-c': String(hashOf(name) % 8), text: initials(name) });
  /** The same product always gets the same colour on every screen. */
  const productChip = (p, strong = false) => h('span', { class: 'pchip' + (strong ? ' is-strong' : ''), 'data-c': String(hashOf(p) % 8), text: p === GENERAL ? 'General' : p });
  const ROLE_OPTS = [['user', 'User · chats and leads (with contact details), remarks, share links; no exports'], ['admin', 'Admin · also answers, knowledge, exports, share links'], ['superuser', 'Superuser · everything incl. users, instructions, audit']];
  const roleName = (r) => (ROLE_OPTS.find(([v]) => v === r)?.[1] || String(r || '')).split(' · ')[0];

  // ---------------- small building blocks ----------------
  function top(title, sub, ...tools) {
    return h('div', { class: 'top' }, h('div', null, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), tools.filter(Boolean).length ? h('div', { class: 'top__tools' }, tools) : null);
  }
  /** Skeleton placeholders while data loads (keeps the class "loading" so code and tests can wait for it to go). */
  const skelLines = (count = 3) => h('div', { class: 'loading skel', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: count }, (_, i) => h('div', { class: 'skel__card' }, h('div', { class: 'skel__line', style: { width: 40 + ((i * 23) % 35) + '%' } }), h('div', { class: 'skel__line skel__line--thin' }), h('div', { class: 'skel__line skel__line--thin', style: { width: '70%' } }))));
  const loading = () => main.replaceChildren(h('div', { class: 'loading skel skel--page', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('div', { class: 'skel__line skel__line--title' }), h('div', { class: 'skel__line skel__line--thin', style: { width: '38%' } }),
    h('div', { class: 'skel__kpis' }, Array.from({ length: 4 }, () => h('div', { class: 'skel__card skel__card--kpi' }, h('div', { class: 'skel__line skel__line--thin', style: { width: '50%' } }), h('div', { class: 'skel__line skel__line--big' })))),
    Array.from({ length: 3 }, (_, i) => h('div', { class: 'skel__card' }, h('div', { class: 'skel__line', style: { width: 45 + i * 12 + '%' } }), h('div', { class: 'skel__line skel__line--thin' }), h('div', { class: 'skel__line skel__line--thin', style: { width: '64%' } })))));
  /** Empty state: what it means, and optionally the one thing to do next. */
  const empty = (title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'empty__icon' }, icon('inbox')), h('b', { text: title }), text ? h('p', { text }) : null, action || null);

  /** Popover under a button (filters, menus). Closes on outside click and Escape. Returns close(). */
  let popClose = null;
  function openPopover(anchor, build, { align = 'left', above = false } = {}) {
    popClose?.();
    const pop = h('div', { class: 'pop' }, build());
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 260;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    pop.style.top = ((above ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + window.scrollY) + 'px'; pop.style.left = (left + window.scrollX) + 'px';
    const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); anchor.setAttribute('aria-expanded', 'false'); if (popClose === close) popClose = null; };
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true));
    document.addEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'true'); popClose = close;
    pop.querySelector('input, button')?.focus();
    return close;
  }
  /** "More" button with a menu: items [{ label, onClick, danger, hint }] (falsy items skipped). */
  function menuBtn(items, label = 'More actions', text = null) {
    const b = h('button', { class: 'btn btn--sm btn--ghost menu-btn', type: 'button', 'aria-label': label, title: label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, text ? [text, icon('chevronDown')] : icon('more'));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      let close = () => { };
      close = openPopover(b, () => h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => h('button', { type: 'button', role: 'menuitem', class: 'menu__item' + (it.danger ? ' is-danger' : ''),
        on: { click: (ev) => { ev.stopPropagation(); close(); it.onClick(); } } }, it.label, it.hint ? h('small', { text: it.hint }) : null))), { align: 'right' });
    });
    b.addEventListener('keydown', (e) => e.stopPropagation()); // Enter on the button must not also open the card underneath
    return b;
  }
  /** Tabs inside a card. items: [[key, label, count?]] */
  function tabStrip(items, current, onPick) {
    const bar = h('div', { class: 'ptabs', role: 'tablist' });
    const draw = (cur) => bar.replaceChildren(...items.map(([key, label, count]) => h('button', { type: 'button', role: 'tab', 'data-tab': key, class: key === cur ? 'is-on' : null, 'aria-selected': String(key === cur),
      on: { click: () => { draw(key); onPick(key); } } }, label, count != null ? h('span', { class: 'n', text: count }) : null)));
    draw(current);
    return bar;
  }
  /** Day-grouped timeline: items newest first → "Today" / "Yesterday" / date headers with a list under each. */
  const dayKeyF = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
  const dayLabelF = new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
  const timeF = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
  function dayLabel(iso) {
    const k = dayKeyF.format(new Date(iso));
    if (k === dayKeyF.format(new Date())) return 'Today';
    if (k === dayKeyF.format(new Date(Date.now() - 864e5))) return 'Yesterday';
    return dayLabelF.format(new Date(iso));
  }
  function timeline(items, at, render) {
    const out = []; let cur = null, list = null;
    for (const it of items) {
      const lbl = dayLabel(at(it));
      if (lbl !== cur) { cur = lbl; list = h('ol', { class: 'tl' }); out.push(h('div', { class: 'day-sep', text: lbl }), list); }
      list.append(render(it));
    }
    return h('div', { class: 'timeline' }, out);
  }
  /** Small dialog on top of the page. body: nodes; onSubmit() returns true to close. */
  function dialog(title, sub, body, submitLabel, onSubmit, { width = 520, danger = false } = {}) {
    const submit = h('button', { class: 'btn ' + (danger ? 'btn--danger-solid' : 'btn--primary'), type: 'submit', text: submitLabel });
    const form = h('form', { class: 'modal__card', style: { width: `min(${width}px, 100%)` }, on: { submit: async (e) => {
      e.preventDefault(); submit.disabled = true;
      try { if (await onSubmit()) closeLayer(); } finally { submit.disabled = false; }
    } } },
      h('div', { class: 'modal__head' }, h('div', null, h('h2', { text: title }), sub ? h('p', { text: sub }) : null), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: closeLayer } }, icon('x'))),
      h('div', { class: 'modal__body' }, body),
      h('div', { class: 'modal__foot' }, h('button', { class: 'btn', type: 'button', text: 'Cancel', on: { click: closeLayer } }), submit));
    openLayer(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, form), true);
    form.querySelector('input:not([type=checkbox]), select, textarea')?.focus();
    return form;
  }

  // ---------------- the filter bar (one component for every list) ----------------
  /**
   * cfg: { id, search: placeholder, seg: { key, label, options: [[value, label]], def }, filters: [{ key, label, options: [[value, label]], multi }],
   *        sort: { options, def }, toggles: [{ key, label, chip, def }], views: [{ label, state }], onChange(state) }
   * The state lives in the address (#/page?key=value, bookmarkable) and is remembered per screen.
   * Returns { el, state, segBox, set(patch), setCounts(map), setResult(text), removeLast(), reset(), activeLabels() }.
   */
  function filterBar(cfg) {
    const defaults = { q: '' };
    if (cfg.seg) defaults[cfg.seg.key] = cfg.seg.def ?? '';
    for (const f of cfg.filters || []) defaults[f.key] = f.multi ? [] : '';
    for (const t of cfg.toggles || []) defaults[t.key] = !!t.def;
    if (cfg.sort) defaults.sort = cfg.sort.def;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const st = clone(defaults);
    const qp = parseHash().query, fromUrl = [...qp.keys()].some((k) => k in defaults);
    const saved = fromUrl ? {} : store.get('des:f:' + cfg.id, {});
    for (const k of Object.keys(defaults)) {
      const v = fromUrl ? qp.get(k) : saved[k];
      if (v == null) continue;
      if (Array.isArray(defaults[k])) st[k] = (Array.isArray(v) ? v : String(v).split(',')).filter(Boolean);
      else if (typeof defaults[k] === 'boolean') st[k] = v === true || v === '1';
      else st[k] = String(v);
    }
    const order = []; // filters in the order they were set, for "Remove last filter"
    const isActive = (k) => k !== 'sort' && (Array.isArray(st[k]) ? st[k].length > 0 : st[k] !== defaults[k]);
    Object.keys(defaults).forEach((k) => { if (isActive(k)) order.push(k); });
    const persist = () => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(st)) {
        if (Array.isArray(v) ? !v.length : v === defaults[k]) continue;
        p.set(k, Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? (v ? '1' : '0') : v);
      }
      setQuery(p); store.set('des:f:' + cfg.id, st);
    };
    const change = (k) => {
      if (k) { const i = order.indexOf(k); if (i >= 0) order.splice(i, 1); if (isActive(k)) order.push(k); }
      persist(); draw(); cfg.onChange(st);
    };

    const searchIn = cfg.search ? h('input', { class: 'input fbar__search', type: 'search', placeholder: cfg.search, 'aria-label': cfg.search.replace(/…$/, ''), value: st.q }) : null;
    searchIn?.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); change('q'); }, 300));
    let counts = {};
    const segBox = cfg.seg ? h('div', { class: 'qchips', role: 'group', 'aria-label': cfg.seg.label || 'Quick views' }) : null;
    const drawSeg = () => segBox?.replaceChildren(...cfg.seg.options.map(([v, l]) => {
      const on = st[cfg.seg.key] === v, c = counts[v || 'all'];
      return h('button', { type: 'button', class: 'qchip' + (on ? ' is-on' : ''), 'aria-pressed': String(on), 'data-seg': v || 'all', on: { click: () => { st[cfg.seg.key] = v; change(cfg.seg.key); } } },
        l, c != null ? h('span', { class: 'qchip__n', text: n(c) }) : null);
    }));
    const sortGroup = () => h('fieldset', { class: 'fpop__group' }, h('legend', { class: 'fpop__title', text: 'Sort' }), h('div', { class: 'fpop__opts' }, cfg.sort.options.map(([v, l]) => {
      const inp = h('input', { type: 'radio', name: 'sort-' + cfg.id, checked: st.sort === v }); inp.addEventListener('change', () => { st.sort = v; change(); });
      return h('label', { class: 'fpop__opt' }, inp, h('span', { text: l }));
    })));
    const viewsGroup = () => {
      const mine = store.get('des:v:' + cfg.id, []);
      return h('fieldset', { class: 'fpop__group' }, h('legend', { class: 'fpop__title', text: 'Saved views' }), h('div', { class: 'fpop__views' },
        cfg.views.map((v) => h('button', { type: 'button', class: 'fpop__view', text: v.label, on: { click: () => applyView(v.state) } })),
        mine.map((v, i) => h('div', { class: 'menu__row' }, h('button', { type: 'button', class: 'fpop__view', text: v.label, on: { click: () => applyView(v.state) } }),
          h('button', { type: 'button', class: 'menu__del', 'aria-label': 'Delete view ' + v.label, on: { click: () => { mine.splice(i, 1); store.set('des:v:' + cfg.id, mine); closePanel(); toast('View deleted'); } } }, icon('x')))),
        h('button', { type: 'button', class: 'link-btn', text: '+ Save current view', on: { click: saveView } })));
    };
    const panel = () => h('div', { class: 'fpop' },
      cfg.compact && cfg.sort ? sortGroup() : null,
      (cfg.filters || []).map((f) => {
        const box = h('div', { class: 'fpop__opts' });
        const find = f.options.length > 8 ? h('input', { class: 'input input--sm', type: 'search', placeholder: `Find ${f.label.toLowerCase()}…`, 'aria-label': 'Find ' + f.label }) : null;
        const drawOpts = () => {
          const t = (find?.value || '').toLowerCase();
          const opts = f.multi ? f.options : [['', 'Any'], ...f.options];
          box.replaceChildren(...opts.filter(([, l]) => !t || l.toLowerCase().includes(t)).map(([v, l]) => {
            const inp = h('input', { type: f.multi ? 'checkbox' : 'radio', name: 'f-' + cfg.id + '-' + f.key, checked: f.multi ? st[f.key].includes(v) : st[f.key] === v });
            inp.addEventListener('change', () => { if (f.multi) st[f.key] = inp.checked ? [...st[f.key], v] : st[f.key].filter((x) => x !== v); else st[f.key] = v; change(f.key); });
            return h('label', { class: 'fpop__opt' }, inp, h('span', { text: l }));
          }));
        };
        find?.addEventListener('input', drawOpts); drawOpts();
        return h('fieldset', { class: 'fpop__group' }, h('legend', { class: 'fpop__title', text: f.label }), find, box);
      }),
      (cfg.toggles || []).length ? h('fieldset', { class: 'fpop__group' }, h('legend', { class: 'fpop__title', text: 'Show' }), cfg.toggles.map((t) => {
        const inp = h('input', { type: 'checkbox', checked: st[t.key] }); inp.addEventListener('change', () => { st[t.key] = inp.checked; change(t.key); });
        return h('label', { class: 'fpop__opt' }, inp, h('span', { text: t.label }));
      })) : null,
      cfg.compact && cfg.views ? viewsGroup() : null);
    const filterBadge = h('span', { class: 'fbar__badge', hidden: true });
    const filterBtn = (cfg.filters?.length || cfg.toggles?.length || cfg.compact) ? h('button', { class: 'btn fbar__add', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      cfg.compact ? icon('sliders') : h('span', { 'aria-hidden': 'true', text: '+' }), cfg.compact ? 'Filter' : ' Filter', filterBadge) : null;
    filterBtn?.addEventListener('click', () => { closePanel = openPopover(filterBtn, panel); });
    const sortSel = cfg.sort && !cfg.compact ? h('select', { class: 'input fbar__sort', 'aria-label': 'Sort' }, cfg.sort.options.map(([v, l]) => h('option', { value: v, text: l }))) : null;
    sortSel?.addEventListener('change', () => { st.sort = sortSel.value; change(); });
    // saved views: built-in presets + the person's own (kept in this browser)
    let closePanel = () => { };
    const applyView = (v) => { closePanel(); Object.assign(st, clone(defaults), clone(v)); if (searchIn) searchIn.value = st.q; order.length = 0; Object.keys(defaults).forEach((k) => { if (isActive(k)) order.push(k); }); change(); };
    const saveView = () => {
      closePanel();
      const name = h('input', { class: 'input', required: true, maxLength: 40, placeholder: 'e.g. My call list' });
      dialog('Save this view', 'The current search, filters and sort, under a name. Saved in this browser.', [h('label', { class: 'field' }, h('span', { text: 'Name' }), name)], 'Save view', () => {
        const list = store.get('des:v:' + cfg.id, []); list.push({ label: name.value.trim(), state: clone(st) }); store.set('des:v:' + cfg.id, list.slice(-12)); toast('View saved'); return true;
      }, { width: 420 });
    };
    const viewsBtn = cfg.views && !cfg.compact ? h('button', { class: 'btn fbar__views', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'Views', icon('chevronDown')) : null;
    viewsBtn?.addEventListener('click', () => {
      const mine = store.get('des:v:' + cfg.id, []);
      let close = () => { };
      const apply = (s) => { close(); Object.assign(st, clone(defaults), clone(s)); if (searchIn) searchIn.value = st.q; order.length = 0; Object.keys(defaults).forEach((k) => { if (isActive(k)) order.push(k); }); change(); };
      close = openPopover(viewsBtn, () => h('div', { class: 'menu', role: 'menu' },
        cfg.views.map((v) => h('button', { type: 'button', role: 'menuitem', class: 'menu__item', text: v.label, on: { click: () => apply(v.state) } })),
        mine.length ? h('div', { class: 'menu__sep', text: 'My views' }) : null,
        mine.map((v, i) => h('div', { class: 'menu__row' }, h('button', { type: 'button', role: 'menuitem', class: 'menu__item', text: v.label, on: { click: () => apply(v.state) } }),
          h('button', { type: 'button', class: 'menu__del', 'aria-label': 'Delete view ' + v.label, on: { click: () => { mine.splice(i, 1); store.set('des:v:' + cfg.id, mine); close(); toast('View deleted'); } } }, icon('x')))),
        h('div', { class: 'menu__sep' }),
        h('button', { type: 'button', role: 'menuitem', class: 'menu__item', text: '+ Save current view…', on: { click: () => {
          close();
          const name = h('input', { class: 'input', required: true, maxLength: 40, placeholder: 'e.g. My call list' });
          dialog('Save this view', 'The current search, filters and sort, under a name. Saved in this browser.', [h('label', { class: 'field' }, h('span', { text: 'Name' }), name)], 'Save view', () => {
            const list = store.get('des:v:' + cfg.id, []); list.push({ label: name.value.trim(), state: clone(st) }); store.set('des:v:' + cfg.id, list.slice(-12)); toast('View saved'); return true;
          }, { width: 420 });
        } } })), { align: 'right' });
    });
    const resultEl = h('span', { class: 'fbar__count', 'aria-live': 'polite' });
    const activeRow = h('div', { class: 'fbar__active' });
    const chips = () => {
      const out = [];
      if (st.q) out.push(['q', `“${st.q}”`, () => { st.q = ''; if (searchIn) searchIn.value = ''; }]);
      if (cfg.seg && cfg.seg.chip !== false && isActive(cfg.seg.key)) out.push([cfg.seg.key, cfg.seg.options.find(([v]) => v === st[cfg.seg.key])?.[1] || st[cfg.seg.key], () => { st[cfg.seg.key] = defaults[cfg.seg.key]; }]);
      for (const f of cfg.filters || []) for (const v of (f.multi ? st[f.key] : st[f.key] ? [st[f.key]] : []))
        out.push([f.key, `${f.label}: ${f.options.find(([x]) => x === v)?.[1] || v}`, () => { st[f.key] = f.multi ? st[f.key].filter((x) => x !== v) : ''; }]);
      for (const t of cfg.toggles || []) if (isActive(t.key)) out.push([t.key, t.chip || t.label, () => { st[t.key] = defaults[t.key]; }]);
      return out;
    };
    const drawActive = () => {
      const list = chips();
      activeRow.replaceChildren(resultEl, ...list.map(([k, label, rm]) => h('span', { class: 'achip' }, h('span', { text: label }),
        h('button', { type: 'button', class: 'achip__x', 'aria-label': 'Remove filter ' + label, on: { click: () => { rm(); change(k); } } }, icon('x')))),
        list.length ? h('button', { class: 'link-btn', type: 'button', text: 'Clear all', on: { click: reset } }) : null);
    };
    const draw = () => {
      drawSeg(); drawActive(); if (sortSel) sortSel.value = st.sort;
      const on = (cfg.filters || []).reduce((a, f) => a + (f.multi ? st[f.key].length : isActive(f.key) ? 1 : 0), 0) + (cfg.toggles || []).filter((t) => isActive(t.key)).length;
      filterBtn?.classList.toggle('is-on', on > 0); filterBadge.hidden = !on; filterBadge.textContent = on;
      if (filterBtn) filterBtn.setAttribute('aria-label', on ? `Filter, ${on} on` : 'Filter');
    };
    function reset() { Object.assign(st, clone(defaults)); if (searchIn) searchIn.value = ''; order.length = 0; change(); }
    function removeLast() {
      const k = order.pop() || Object.keys(defaults).find(isActive); if (!k) return;
      st[k] = clone(defaults)[k]; if (k === 'q' && searchIn) searchIn.value = ''; change();
    }
    const el = cfg.compact
      ? h('div', { class: 'fbar fbar--compact' }, segBox, h('div', { class: 'fbar__row' }, searchIn, filterBtn), activeRow)
      : h('div', { class: 'fbar' }, h('div', { class: 'fbar__row' }, searchIn, filterBtn, h('span', { class: 'sp' }), sortSel, viewsBtn), segBox, activeRow);
    draw();
    return {
      el, state: st, segBox,
      set(patch) { Object.assign(st, patch); if (searchIn) searchIn.value = st.q; Object.keys(patch).forEach((k) => { const i = order.indexOf(k); if (i >= 0) order.splice(i, 1); if (isActive(k)) order.push(k); }); persist(); draw(); cfg.onChange(st); },
      setCounts(c) { counts = c || {}; drawSeg(); },
      setResult(text) { resultEl.textContent = text; },
      removeLast, reset, activeLabels: () => chips().map(([, l]) => l),
    };
  }
  /** "Nothing matches" with the filters that caused it and a way out. */
  function zeroState(bar, title) {
    const labels = bar.activeLabels();
    return empty(title, labels.length ? 'Filters in use: ' + labels.join(' · ') : 'Nothing here yet.',
      labels.length ? h('div', { class: 'empty__actions' }, h('button', { class: 'btn', type: 'button', text: 'Remove last filter', on: { click: () => bar.removeLast() } }), h('button', { class: 'btn btn--ghost', type: 'button', text: 'Clear all', on: { click: () => bar.reset() } })) : null);
  }

  // ---------------- charts and stat cards ----------------
  /** Single-series vertical bars with hover tooltip, recessive grid, baseline. data: [{label, value, tip}] */
  function barChart(data, { valueLabel = 'Value', height = 220 } = {}) {
    const wrap = h('div', { class: 'chart' });
    const tip = h('div', { class: 'tip', hidden: true });
    const draw = () => {
      wrap.replaceChildren();
      const W = Math.max(320, wrap.clientWidth || 640), H = height, m = { l: 34, r: 6, t: 10, b: 24 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const max = Math.max(1, ...data.map((d) => d.value));
      const step = Math.pow(10, Math.floor(Math.log10(max))); const nice = Math.ceil(max / step) * step; const yMax = nice < max ? max : nice;
      const ticks = 4, ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${valueLabel} per day, ${data.length} days, peak ${n(max)}`);
      const el = (t, a) => { const e = document.createElementNS(ns, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); svg.append(e); return e; };
      for (let i = 0; i <= ticks; i++) {
        const v = (yMax / ticks) * i, y = m.t + ih - (v / yMax) * ih;
        if (i > 0) el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid-line' });
        const t = el('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }); t.textContent = Number.isInteger(v) ? n(v) : v.toFixed(1);
      }
      el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'axis-line' });
      const bw = iw / data.length, gap = Math.min(2 + bw * 0.25, 10), w = Math.max(1, bw - gap);
      const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 64)));
      data.forEach((d, i) => {
        const x = m.l + i * bw + gap / 2, bh = (d.value / yMax) * ih, y = m.t + ih - bh, y0 = m.t + ih;
        let bar = null;
        if (d.value > 0) {
          const r = Math.min(4, w / 2, bh);
          bar = el('path', { class: 'bar', d: `M${x},${y0} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y0} Z` });
        }
        // every n-th day plus the last one, but skip a regular label that would crowd the last ("Nov 17 / Nov 18" overlap)
        const last = data.length - 1;
        if (i === last || (i % every === 0 && last - i >= every)) { const t = el('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick' }); t.textContent = d.label; }
        const hit = el('rect', { x: m.l + i * bw, y: m.t, width: bw, height: ih, class: 'hit' });
        hit.addEventListener('mouseenter', () => {
          bar?.classList.add('is-hover');
          tip.replaceChildren(h('b', { text: d.tip || n(d.value) }), d.label); tip.hidden = false;
          const rect = svg.getBoundingClientRect(), sx = rect.width / W;
          tip.style.left = (x + w / 2) * sx + 'px'; tip.style.top = Math.min(y, y0 - 4) * sx + 'px';
        });
        hit.addEventListener('mouseleave', () => { bar?.classList.remove('is-hover'); tip.hidden = true; });
      });
      wrap.append(svg, tip);
    };
    const ro = new ResizeObserver(debounce(() => { if (wrap.isConnected) draw(); }, 120)); ro.observe(wrap);
    requestAnimationFrame(draw);
    return { el: wrap };
  }
  /** Horizontal bars for ranked categories (one hue; label + value always visible). */
  function hbars(rows, { onPick, empty: emptyText = 'Nothing yet.', share = false } = {}) {
    if (!rows.length) return h('div', { class: 'muted', text: emptyText });
    const max = Math.max(1, ...rows.map((r) => r.n)), sum = rows.reduce((a, r) => a + r.n, 0) || 1;
    return h('div', { class: 'hbars' }, rows.map((r) => h('div', { class: 'hbar', title: `${r.label}: ${n(r.n)}` },
      onPick ? h('button', { class: 'hbar__label hbar__pick', type: 'button', text: r.label, on: { click: () => onPick(r) } }) : h('span', { class: 'hbar__label', text: r.label }),
      h('div', { class: 'hbar__track' }, h('div', { class: 'hbar__fill', style: { width: (r.n / max) * 100 + '%' } })),
      h('span', { class: 'hbar__n' }, n(r.n), share ? h('small', { text: ` ${Math.round((r.n / sum) * 100)}%` }) : null))));
  }
  /** Up 12% / down 3 against the previous period of the same length; the colour says whether that is good. */
  function delta(cur, prev, { goodUp = true } = {}) {
    if (prev == null || Number.isNaN(prev)) return null;
    const d = cur - prev;
    if (!d) return null;
    const pct = prev > 0 ? Math.round((d / prev) * 100) : null, good = (d > 0) === goodUp;
    return h('span', { class: 'delta ' + (good ? 'is-good' : 'is-bad'), title: `Previous period: ${n(prev)}` }, icon(d > 0 ? 'arrowUp' : 'arrowDown'), pct != null ? Math.abs(pct) + '%' : n(Math.abs(d)));
  }
  function statCard({ label, value, sub, d, href, meter }) {
    return h(href ? 'a' : 'div', { class: 'card kpi stat' + (href ? ' is-link' : ''), href: href || null },
      h('div', { class: 'kpi__label', text: label }),
      h('div', { class: 'stat__row' }, h('div', { class: 'kpi__value', text: value }), d || null),
      meter ? h('div', { class: 'meter' + (meter.pct >= 100 ? ' is-full' : meter.pct >= 80 ? ' is-warn' : ''), role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(meter.pct)), 'aria-label': label },
        h('div', { class: 'meter__fill', style: { width: Math.min(100, meter.pct) + '%' } })) : null,
      sub ? h('div', { class: 'kpi__sub', text: sub }) : null);
  }

  // ---------------- sign-in / shell ----------------
  function showLogin(msg = '') {
    disconnectLive(); clearInterval(idleTimer); document.querySelector('.idle-warning')?.remove(); closeLayer(); popClose?.(); document.querySelector('.cmdk')?.remove();
    $('#app').hidden = true; $('#login').hidden = false;
    $('#loginErr').textContent = msg; $('#passwordInput').value = ''; ($('#emailInput').value ? $('#passwordInput') : $('#emailInput')).focus();
  }
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await fetch('/api/admin/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#emailInput').value.trim(), password: $('#passwordInput').value, remember: $('#rememberInput').checked }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 423) { $('#loginErr').textContent = `Too many wrong passwords. Try again after ${new Date(j.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, or ask a superuser to unlock you.`; return; }
      if (!r.ok) { $('#loginErr').textContent = r.status === 401 ? 'Wrong email or password.' : `The backend answered ${r.status}. Is it running?`; $('#passwordInput').value = ''; return; }
      boot();
    } catch { $('#loginErr').textContent = 'Could not reach the backend. Is it running?'; }
  });
  async function signOut(msg = 'Signed out.') { try { await api('/admin/auth/logout', { method: 'POST', body: {} }); } catch { } showLogin(msg); }

  async function boot() {
    try { const me = await api('/admin/auth/me'); state.me = me.user; state.perms = new Set(me.permissions); state.session = me.session; state.status = await api('/admin/status'); }
    catch (e) { if (e.message !== 'unauthorized') showLogin('Could not reach the backend. Is it running?'); return; }
    // menu: only the pages this role may open; a group label only when something under it is visible
    document.querySelectorAll('#nav button[data-perm]').forEach((b) => { b.hidden = !b.dataset.perm.split(' ').some(can); });
    document.querySelectorAll('#nav [data-group]').forEach((g) => {
      let x = g.nextElementSibling, any = false;
      while (x && !x.hasAttribute('data-group')) { if (!x.hidden) any = true; x = x.nextElementSibling; }
      g.hidden = !any;
    });
    $('#login').hidden = true; $('#app').hidden = false;
    $('#app').classList.toggle('is-collapsed', !!store.get('des:side', false));
    document.body.classList.toggle('is-compact', !!store.get('des:compact', false));
    lastActivity = Date.now(); watchIdle(state.session);
    renderFoot(); renderStatus(); refreshReviewCount(); connectLive();
    if (!location.hash) location.hash = '#/overview'; else route();
  }
  function openPassword() {
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minLength: 10, required: true });
    const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true });
    dialog('Change password', 'Other devices are signed out afterwards.', [
      h('label', { class: 'field' }, h('span', { text: 'Current password' }), cur),
      h('label', { class: 'field' }, h('span', { text: 'New password (at least 10 characters)' }), pw),
      h('label', { class: 'field' }, h('span', { text: 'Repeat new password' }), pw2)], 'Change password', async () => {
      if (pw.value !== pw2.value) { toast('The new passwords do not match', true); return false; }
      try { await api('/admin/auth/password', { method: 'POST', body: { current: cur.value, password: pw.value } }); toast('Password changed. Other devices were signed out.'); return true; } catch (err) { fail(err); return false; }
    }, { width: 440 });
  }
  /** Sidebar footer: who is signed in and their account actions (system status lives in the top bar). */
  function renderFoot() {
    const foot = $('#sideFoot'); const me = state.me;
    const compact = document.body.classList.contains('is-compact');
    // one row (avatar, name, role); the account actions open in a small menu above it
    const note = state.session?.remember ? 'Kept signed in on this computer' : `Signs out after ${state.session?.idle_minutes || 30} min without use`;
    const btn = h('button', { type: 'button', class: 'side__user', title: `${me.name || me.email} · account`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      avatar(me.name || me.email, 'avatar--sm'), h('span', { class: 'side__user-text' }, h('b', { text: me.name || me.email }), h('small', { text: roleName(me.role) })), h('span', { class: 'side__user-more' }, icon('more')));
    const item = (text, onClick, cls = '') => h('button', { type: 'button', role: 'menuitem', class: 'menu__item ' + cls, text, on: { click: (e) => { e.stopPropagation(); close(); onClick(); } } });
    let close = () => { };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      close = openPopover(btn, () => h('div', { class: 'menu', role: 'menu' },
        h('div', { class: 'menu__note', text: note }),
        item('Change password', openPassword),
        item(compact ? 'Comfortable view' : 'Compact view', () => { const c = !document.body.classList.contains('is-compact'); document.body.classList.toggle('is-compact', c); store.set('des:compact', c); renderFoot(); }),
        h('div', { class: 'menu__sep' }),
        item('Sign out', () => signOut(), 'is-danger')), { above: true });
    });
    foot.replaceChildren(btn);
  }
  /** Top-right status pill: live updates · AI mode · today's spend against the daily budget. */
  async function renderStatus() {
    const s = state.status, box = $('#statusPill'); if (!s || !box) return;
    let budget = null; try { budget = (await fetch('/api/health').then((r) => r.json())).budget; } catch { }
    const pct = budget && budget.budget ? (budget.spent / budget.budget) * 100 : 0;
    box.replaceChildren(
      h('span', { id: 'livePill', class: 'live-pill' + (live.es?.readyState === 1 ? '' : ' is-off'), title: 'Live updates: new chats, messages and leads appear without reloading', text: live.es?.readyState === 1 ? 'Live' : 'Connecting…' }),
      h('span', { class: 'status__ai', title: s.model }, h('span', { class: 'dot' + (s.mock ? ' is-mock' : '') }), s.mock ? 'Mock mode' : 'AI on'),
      budget ? h('span', { class: 'status__budget' + (pct >= 100 ? ' is-full' : pct >= 80 ? ' is-warn' : ''), title: `Today: ${usd(budget.spent)} of the ${usd(budget.budget)} daily AI budget. At 100% DES stops answering and shows the Sales contact.` },
        h('span', { class: 'mini-meter', 'aria-hidden': 'true' }, h('span', { style: { width: Math.min(100, pct) + '%' } })), `${usd(budget.spent)} / ${usd(budget.budget)}`) : null);
  }
  async function refreshReviewCount() {
    if (!can('finetune.manage')) return;
    try { const q = await api('/admin/review-queue'); const b = $('#reviewCount'); b.hidden = !q.length; b.textContent = q.length; state.reviewCount = q.length; } catch { }
  }
  $('#nav').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-page]'); if (b) location.hash = '#/' + b.dataset.page; });
  $('#sideCollapse').addEventListener('click', () => { const c = !$('#app').classList.contains('is-collapsed'); $('#app').classList.toggle('is-collapsed', c); store.set('des:side', c); $('#sideCollapse').setAttribute('aria-label', c ? 'Expand the menu' : 'Collapse the menu'); });
  $('#cmdkBtn').addEventListener('click', () => openPalette());
  window.addEventListener('hashchange', route);

  let navSeq = 0; // bumped on every navigation: a page that loaded slowly must not draw over the next one
  const navToken = () => { const my = navSeq; return () => my !== navSeq; };
  function route() {
    if ($('#app').hidden) return;
    navSeq++;
    // old addresses: #/leads and #/conversations/<lead filter> open Conversations & leads with that filter
    const old = location.hash.match(/^#\/?(?:leads|conversations\/(leads|lead|uncalled|new|contacted|qualified|closed))$/);
    if (old) history.replaceState(null, '', '#/conversations?lead=' + ({ leads: '', lead: '', closed: 'not_interested' }[old[1]] ?? old[1] ?? ''));
    const { page, arg } = parseHash();
    // Conversations & leads fills the screen (100dvh): its list and open conversation scroll inside their own panels
    $('#app').classList.toggle('is-fill', page === 'conversations');
    document.querySelectorAll('#nav button').forEach((b) => { const on = b.dataset.page === page; b.classList.toggle('is-on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    closeLayer(); popClose?.();
    const pages = { overview: pageOverview, conversations: pageConversations, finetune: pageFinetune, review: pageReview, kb: pageKb, settings: pageSettings, users: pageUsers, audit: pageAudit };
    const btn = document.querySelector(`#nav button[data-page="${page}"]`);
    live.page = null; // the page sets its own live handler
    if (!pages[page] || !btn || btn.hidden) return pageOverview(); // not this role's page
    pages[page](arg);
    main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  }

  // ---------------- command palette (Ctrl + K) ----------------
  function openPalette() {
    if ($('#app').hidden || document.querySelector('.cmdk')) return;
    const input = h('input', { class: 'cmdk__input', type: 'search', placeholder: 'Search chats, leads, products, website pages, users…', 'aria-label': 'Search everything', autocomplete: 'off' });
    const list = h('div', { class: 'cmdk__list', role: 'listbox', 'aria-label': 'Results' });
    let results = [], sel = 0, seq = 0, kbCache = null, usersCache = null;
    const pages = [...document.querySelectorAll('#nav button[data-page]')].filter((b) => !b.hidden).map((b) => ({ group: 'Go to', label: b.querySelector('span').textContent, go: () => { location.hash = '#/' + b.dataset.page; } }));
    const actions = [
      can('conversations.view') ? { group: 'Quick views', label: 'Leads not called yet', sub: 'Conversations & leads', go: () => { location.hash = '#/conversations?lead=uncalled&sort=oldest'; } } : null,
      can('conversations.view') ? { group: 'Quick views', label: 'New this week', sub: 'Conversations & leads', go: () => { location.hash = '#/conversations?days=7'; } } : null,
      can('conversations.view') ? { group: 'Quick views', label: 'Demo requests', sub: 'Conversations & leads', go: () => { location.hash = '#/conversations?q=demo'; } } : null,
      can('finetune.manage') ? { group: 'Quick views', label: 'Add an approved answer', sub: 'Fine-tune answers', go: () => openGolden({}) } : null,
      can('users.manage') ? { group: 'Quick views', label: 'Add a user', sub: 'Users', go: () => openAddUser() } : null,
    ].filter(Boolean);
    const draw = () => {
      list.replaceChildren(); let g = null;
      results.forEach((r, i) => {
        if (r.group !== g) { g = r.group; list.append(h('div', { class: 'cmdk__group', text: g })); }
        list.append(h('button', { type: 'button', role: 'option', class: 'cmdk__item' + (i === sel ? ' is-on' : ''), 'aria-selected': String(i === sel),
          on: { click: () => pick(i), mousemove: () => { if (sel !== i) { sel = i; draw(); } } } }, h('span', { class: 'cmdk__label', text: r.label }), r.sub ? h('span', { class: 'cmdk__sub', text: r.sub }) : null));
      });
      if (!results.length) list.append(h('div', { class: 'cmdk__empty', text: 'Nothing found. Try a name, company, product or page title.' }));
      list.querySelector('.is-on')?.scrollIntoView?.({ block: 'nearest' });
    };
    const close = () => { holder.remove(); };
    const pick = (i) => { const r = results[i]; if (!r) return; close(); r.go(); };
    const search = debounce(async () => {
      const t = input.value.trim().toLowerCase(), id = ++seq;
      const base = t ? [...actions, ...pages].filter((p) => p.label.toLowerCase().includes(t)) : [...actions, ...pages];
      const prods = t && can('finetune.manage') ? state.status.products.filter((p) => p.toLowerCase().includes(t)).slice(0, 5).map((p) => ({ group: 'Products', label: p === GENERAL ? 'General (all products)' : p, sub: 'Fine-tune answers', go: () => { location.hash = '#/finetune/' + encodeURIComponent(p); } })) : [];
      results = [...base, ...prods]; sel = 0; draw();
      if (t.length < 2) return;
      const [convs, docs, users] = await Promise.all([
        can('conversations.view') ? api('/admin/conversations?limit=6&q=' + encodeURIComponent(t)).catch(() => []) : [],
        can('kb.manage') ? (kbCache ||= api('/admin/kb').then((k) => k.docs).catch(() => [])) : [],
        can('users.manage') ? (usersCache ||= api('/admin/users').catch(() => [])) : []]);
      if (id !== seq) return;
      results = [
        ...convs.map((c) => ({ group: 'Conversations & leads', label: c.name, sub: [c.company, c.lead_status ? 'Lead: ' + leadName(c.lead_status) : null, ago(c.started_at)].filter(Boolean).join(' · '), go: () => openConversation(c.id) })),
        ...base, ...prods,
        ...docs.filter((d) => (d.title || '').toLowerCase().includes(t) || d.url.toLowerCase().includes(t)).slice(0, 5).map((d) => ({ group: 'Website pages', label: d.title || d.url, sub: shortPath(d.url), go: () => { location.hash = '#/kb?q=' + encodeURIComponent(t); } })),
        ...users.filter((u) => `${u.email} ${u.name || ''}`.toLowerCase().includes(t)).slice(0, 5).map((u) => ({ group: 'Users', label: u.name || u.email, sub: `${u.email} · ${roleName(u.role)}`, go: () => { location.hash = '#/users?q=' + encodeURIComponent(t); } })),
      ];
      sel = 0; draw();
    }, 180);
    input.addEventListener('input', search);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    });
    const holder = h('div', { class: 'modal cmdk', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search', on: { keydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } } } },
      h('div', { class: 'scrim', on: { click: close } }),
      h('div', { class: 'cmdk__card' }, h('div', { class: 'cmdk__bar' }, input, h('kbd', { text: 'Esc' })), list,
        h('div', { class: 'cmdk__foot', text: '↑ ↓ to move · Enter to open · Esc to close' })));
    document.body.append(holder); input.focus(); search();
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === '/' && !typing(e) && !layer.childElementCount && !$('#app').hidden) { e.preventDefault(); openPalette(); }
  });

  // =====================================================================================
  // Overview
  // =====================================================================================
  async function pageOverview(opts) {
    const moved = navToken();
    if (!opts?.silent) loading();
    const d = state.days;
    let o, prev, act, budget = null, uncalled = null;
    try {
      [o, prev, act] = await Promise.all([api('/admin/overview?days=' + d), api('/admin/overview?days=' + Math.min(365, d * 2)), api('/admin/activity?limit=80')]);
      budget = (await fetch('/api/health').then((r) => r.json()).catch(() => ({}))).budget || null;
      if (can('conversations.view')) uncalled = (await api('/admin/conversation-counts').catch(() => null))?.uncalled ?? null;
    } catch (e) { return moved() ? undefined : fail(e); }
    if (moved() || currentPage() !== 'overview') return;
    // previous period = the same length just before (2N days minus the last N); only when the 2N window is complete
    const k = o.kpi, p2 = prev.kpi, complete = prev.days === d * 2;
    const before = (key) => (complete ? p2[key] - k[key] : null);
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, [7, 30, 90].map((x) => h('button', {
      type: 'button', class: x === d ? 'is-on' : '', text: x + ' days', 'aria-pressed': String(x === d), on: { click: () => { state.days = x; pageOverview(); } },
    })));
    const thumbsTotal = k.thumbs_up + k.thumbs_down;
    const budgetPct = budget?.budget ? (budget.spent / budget.budget) * 100 : 0;

    // needs attention: the work waiting right now
    const attention = [];
    if (state.reviewCount && can('finetune.manage')) attention.push(h('a', { class: 'attn__item', href: '#/review' }, h('b', { text: n(state.reviewCount) }), ` disliked answer${state.reviewCount === 1 ? '' : 's'} to review`));
    const newProducts = can('finetune.manage') ? state.status?.products_new || [] : [];
    if (newProducts.length) attention.push(h('a', { class: 'attn__item', href: '#/finetune/' + encodeURIComponent(newProducts[0]), title: newProducts.join(', ') }, h('b', { text: n(newProducts.length) }), ` new product${newProducts.length === 1 ? '' : 's'} from the website to check`));
    if (uncalled) attention.push(h('a', { class: 'attn__item', href: '#/conversations?lead=uncalled&sort=oldest' }, h('b', { text: n(uncalled) }), ` lead${uncalled === 1 ? '' : 's'} not called yet`));
    if (budgetPct >= 80) attention.push(h('span', { class: 'attn__item is-bad' }, h('b', { text: Math.round(budgetPct) + '%' }), ' of today’s AI budget used'));

    // chart with a metric switch
    const METRICS = [['questions', 'Questions'], ['conversations', 'Chats'], ['leads', 'Leads']];
    let metric = store.get('des:ovMetric', 'questions'); if (!METRICS.some(([m]) => m === metric)) metric = 'questions';
    const chartBox = h('div');
    const drawChart = () => chartBox.replaceChildren(barChart(o.daily.map((x) => ({ label: dayf.format(new Date(x.day + 'T00:00:00Z')), value: x[metric] || 0, tip: `${n(x.questions)} questions · ${n(x.conversations)} chats · ${n(x.leads)} leads` })), { valueLabel: METRICS.find(([m]) => m === metric)[1] }).el);
    const mSeg = h('div', { class: 'seg seg--sm', role: 'group', 'aria-label': 'Show' }, METRICS.map(([m, l]) => h('button', { type: 'button', class: m === metric ? 'is-on' : '', 'aria-pressed': String(m === metric), text: l,
      on: { click: (e) => { metric = m; store.set('des:ovMetric', m); mSeg.querySelectorAll('button').forEach((b) => { const on = b === e.currentTarget; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); }); drawChart(); } } })));
    drawChart();

    // what visitors ask about: General would dwarf every product, so it is a note, not a bar
    const general = o.products.find((x) => x.product === GENERAL);
    const productRows = o.products.filter((x) => x.product !== GENERAL).map((x) => ({ label: x.product, n: x.n }));

    // activity: grouped by day, filter chips, "load more"
    const ACT_FILTERS = [['', 'All'], ['lead', 'Leads'], ['conversation', 'Chats'], ['feedback', 'Feedback']];
    let actFilter = '', actShown = 12;
    const actBox = h('div');
    const actChips = h('div', { class: 'qchips qchips--sm', role: 'group', 'aria-label': 'Show activity' });
    const drawAct = () => {
      actChips.replaceChildren(...ACT_FILTERS.map(([v, l]) => h('button', { type: 'button', class: 'qchip' + (v === actFilter ? ' is-on' : ''), 'aria-pressed': String(v === actFilter), text: l, on: { click: () => { actFilter = v; actShown = 12; drawAct(); } } })));
      const rows = act.filter((a) => !actFilter || a.type === actFilter);
      actBox.replaceChildren(rows.length ? timeline(rows.slice(0, actShown), (a) => a.at, activityItem) : empty('No activity yet', 'Chats show up here as soon as visitors use the widget.'),
        rows.length > actShown ? h('div', { class: 'loadmore' }, h('button', { class: 'btn btn--sm', type: 'button', text: 'Show more', on: { click: () => { actShown += 12; drawAct(); } } })) : null);
    };
    drawAct();
    const convHref = (extra) => can('conversations.view') ? `#/conversations?${extra}&days=${d}` : null;

    // one grid: 4 main numbers · a strip of smaller numbers · the chart · three equal columns · the folded safety card
    const mini = (label, value, sub, href) => h(href ? 'a' : 'div', { class: 'ministat' + (href ? ' is-link' : ''), href: href || null },
      h('span', { class: 'ministat__label', text: label }), h('b', { class: 'ministat__value', text: value }), sub ? h('span', { class: 'ministat__sub', text: sub }) : null);
    main.replaceChildren(
      top('Overview', `Last ${o.days} days`, seg),
      attention.length ? h('div', { class: 'attn', role: 'status' }, h('span', { class: 'attn__label', text: 'Needs attention' }), attention) : null,
      h('div', { class: 'ov' },
        h('div', { class: 'ov__kpis' },
          statCard({ label: 'Qualified', value: n(k.qualified ?? 0), sub: `of ${n(k.leads)} sign-ups · ${n(k.demos)} asked for a demo`, d: delta(k.qualified ?? 0, before('qualified')), href: convHref('lead=&lstatus=qualified') }),
          statCard({ label: 'Chats', value: n(k.conversations), sub: `${n(k.visitors)} visitors`, d: delta(k.conversations, before('conversations')), href: convHref('lead=') }),
          statCard({ label: 'Answer rating', value: k.avg_rating ? `${k.avg_rating.toFixed(1)} / 5` : '—', sub: k.surveys ? `${n(k.surveys)} surveys` : 'no surveys yet', href: can('finetune.manage') ? '#/review' : null }),
          statCard({ label: 'AI spend today', value: budget ? usd(budget.spent) : '—', sub: budget ? `of ${usd(budget.budget)} daily budget` : `${usd(k.cost_usd)} in ${d} days`, meter: budget ? { pct: budgetPct } : null })),
        h('div', { class: 'card ov__strip' },
          mini('Questions asked', n(k.questions), k.conversations ? `${(k.questions / k.conversations).toFixed(1)} per chat` : null),
          mini('Thumbs up', thumbsTotal ? `${Math.round((k.thumbs_up / thumbsTotal) * 100)}%` : '—', thumbsTotal ? `${n(k.thumbs_up)} up · ${n(k.thumbs_down)} down` : 'no votes yet'),
          mini('Approved answers used', n(k.approved_used), 'replies based on your answers', can('finetune.manage') ? '#/finetune' : null),
          mini(`AI cost, ${d} days`, usd(k.cost_usd), `${n(k.ai_calls)} AI calls`)),
        h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Per day' }), h('p', { text: 'UTC days' })), mSeg), h('div', { class: 'card__body' }, chartBox)),
        h('div', { class: 'ov__cols' },
          h('section', { class: 'card ov__col' }, h('div', { class: 'card__head' }, h('h2', { text: 'What visitors ask about' })),
            h('div', { class: 'card__body' }, hbars(productRows, { onPick: can('finetune.manage') ? (r) => { location.hash = '#/finetune/' + encodeURIComponent(r.label); } : null, empty: 'No product questions yet.' }),
              general ? h('p', { class: 'note ov__note' }, `Plus ${n(general.n)} general questions (company, contact, demo). `, can('finetune.manage') ? h('a', { href: '#/finetune/General', text: 'Fine-tune General' }) : null) : null)),
          h('section', { class: 'card ov__col' }, h('div', { class: 'card__head' }, h('h2', { text: 'Leads by product interest' })),
            h('div', { class: 'card__body' }, hbars(o.leadProducts.map((x) => ({ label: x.product, n: x.n })), { empty: 'No leads yet.', share: true }))),
          h('section', { class: 'card ov__col ov__col--activity' }, h('div', { class: 'card__head' }, h('h2', { text: 'Latest activity' }), actChips),
            h('div', { class: 'card__body ov__scroll' }, actBox))),
        h('details', { class: 'card card--fold' }, h('summary', { class: 'card__head' }, h('div', null, h('h2', { text: `Replies the safety rules changed (${n(k.blocked)})` }), h('p', { text: 'DES answered with a standard message instead of its own reply.' }))),
          h('div', { class: 'card__body' }, hbars(o.blocked.map((b) => ({ label: blockLabel(b.reason), n: b.n })), { empty: 'None in this period.' })))),
    );
  }
  function activityItem(a) {
    const map = {
      conversation: ['chat', '', 'started a chat'], lead: ['flag', 'lead', a.status === 'demo' ? 'asked for a demo' : 'became a lead'],
      feedback: a.status === 'down' ? ['down', 'down', 'disliked an answer'] : a.status === 'up' ? ['up', 'up', 'liked an answer'] : ['star', '', 'rated the chat'],
    };
    const [ic, cls, verb] = map[a.type] || ['dot', '', a.type];
    const open = () => a.conversation_id && can('conversations.view') && openConversation(a.conversation_id);
    return h('li', { class: 'tl__item is-click', tabindex: '0', role: 'button', on: { click: open, keydown: (e) => { if (e.key === 'Enter') open(); } } },
      h('span', { class: 'tl__icon tl__icon--' + cls }, icon(ic)),
      h('div', { class: 'tl__main' }, h('div', { class: 'tl__text' }, h('b', { text: a.who || 'Visitor' }), ' ', verb),
        a.detail ? h('div', { class: 'tl__detail', text: a.detail }) : null,
        h('div', { class: 'tl__meta' }, h('time', { datetime: a.at, text: timeF.format(new Date(a.at)) }))));
  }

  // =====================================================================================
  // Conversations & leads: cards, filter bar, list / pipeline, call list
  // =====================================================================================
  async function downloadLeads() {
    try { const r = await api('/admin/export/leads.csv', { raw: true }); const url = URL.createObjectURL(await r.blob()); const a = h('a', { href: url, download: `des-leads-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('Leads CSV downloaded'); } catch (e) { fail(e); }
  }
  /** Every sign-up is a lead, so two tabs: who still needs a call, and everyone. Call results live in Filter. */
  const LEAD_TABS = [['uncalled', 'To call'], ['', 'Everyone']];
  const DAY_OPTS = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];
  /** Names typed in capitals ("JOHN OLIVER BUGAYONG") read as shouting in a list: shown in normal case. */
  const displayName = (s) => {
    const t = String(s || '').trim();
    return t.length > 3 && t === t.toUpperCase() && /[A-Z]/.test(t) ? t.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : t;
  };
  /** Company values that say nothing ("Unknown", "Not provided yet") are left out. */
  const realValue = (s) => (s && !/^(unknown|none|n\/?a|-+|not (provided|specified|given|sure)( yet)?|no company|individual)$/i.test(String(s).trim()) ? s : null);
  /** "Call due now" (overdue) or "Next call Thu 2:00 PM" for leads with a follow-up time. */
  function nextCallFact(c) {
    const text = nextCallText(c.lead_status, c.next_action_at, whenShort);
    return text ? h('span', { class: text.due ? 'is-warn' : '', title: c.next_action_at ? when(c.next_action_at) : '', text: text.label }) : null;
  }
  /** Call again: at its time, or now when no time was set. Contacted: at its follow-up time. Others: no next call. */
  function nextCallText(status, at, fmtTime = when) {
    if (status === 'call_again' && !at) return { due: true, label: 'Call now' };
    if (!at || !['call_again', 'contacted'].includes(status)) return null;
    const due = new Date(at) <= new Date();
    return { due, label: due ? 'Call due now' : (status === 'contacted' ? 'Follow up ' : 'Next call ') + fmtTime(at) };
  }
  const whenShortF = new Intl.DateTimeFormat('en-PH', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
  const whenShort = (iso) => (new Date(iso) - Date.now() < 6 * 864e5 ? whenShortF.format(new Date(iso)) : when(iso));
  /** One conversation as a card: name and mobile first, then what they need, then one line of facts. kanban = column card (no status: the column says it). */
  function convCard(c, open, { kanban = false } = {}) {
    const products = [...new Set([...(c.product_interest || []), ...(c.products || [])])].filter((p) => p && p !== GENERAL);
    // what they need, in their words: the need (unless it only says "demo requested", which the facts line shows), else their first question
    const need = c.need && !/^demo requested.?$/i.test(c.need.trim()) ? c.need : null;
    let line = need || c.first_question || (c.summary && !/^(Sample chat|Imported lead)/.test(c.summary) ? c.summary : '') || (c.turns ? '' : 'Opened the chat, sent nothing');
    if (/^demo requested\.?$/i.test(String(line).trim()) && c.demo_requested) line = ''; // already in the facts line
    const name = displayName(c.name), company = realValue(c.company);
    const card = h('article', { class: 'rcard is-click' + (kanban ? ' rcard--kanban' : '') + (live.active.has(c.id) ? ' is-live' : '') + (c.lead_id ? ' is-lead' : ''), 'data-id': c.id, tabindex: '0', role: 'button', 'aria-label': `Open the conversation with ${name}`,
      on: { click: () => open(c.id), keydown: (e) => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(c.id); } } } },
      h('div', { class: 'rcard__main' },
        h('div', { class: 'rcard__top' },
          h('b', { class: 'rcard__title', text: name, title: name }),
          !kanban && company ? h('span', { class: 'rcard__co', text: company, title: company }) : null,
          h('span', { class: 'live-dot', title: 'Active now', 'aria-label': 'Active now' }),
          h('span', { class: 'sp' }),
          kanban ? null : h('time', { class: 'rcard__time', datetime: c.started_at, text: ago(c.started_at), title: when(c.started_at) })),
        kanban ? h('div', { class: 'rcard__sub', text: ago(c.started_at) }) : null,
        h('div', { class: 'rcard__line' + (line ? '' : ' is-empty'), text: line || 'No details given', title: line || '' }),
        // one coloured element (the lead status); the rest is a plain line of text
        h('div', { class: 'rcard__meta' },
          c.lead_id && !kanban ? leadBadge(c.lead_status) : null,
          h('span', { class: 'rcard__facts' }, [
            c.agent_name ? h('span', { class: 'is-warn', text: 'With ' + c.agent_name }) : null,
            nextCallFact(c),
            c.attempts ? h('span', { text: plural(c.attempts, 'unanswered call') }) : null,
            c.lead_status === 'not_interested' && c.lost_reason ? h('span', { text: c.lost_reason }) : null,
            c.demo_requested ? h('span', { text: 'Demo requested' }) : null,
            c.status === 'ended' ? h('span', { class: 'is-bad', text: STATUS_BADGE.ended[0] }) : null,
            products.length ? h('span', { text: products.slice(0, 2).join(', ') + (products.length > 2 ? ` +${products.length - 2}` : '') }) : null,
          ].filter(Boolean).flatMap((x, i) => (i ? [h('span', { class: 'rcard__sep', 'aria-hidden': 'true', text: '·' }), x] : [x]))))));
    return card;
  }

  async function pageConversations() {
    const PAGE = 30;
    // telemarketers (User role) get the plain list; managers can also switch to the Pipeline board
    const manager = state.me.role !== 'user';
    let view = store.get('des:convView', 'list'); if (view !== 'pipeline' || !can('leads.view') || !manager) view = 'list';
    let items = [], total = 0, seq = 0;
    const listEl = h('div', { class: 'rlist' });
    const moreBox = h('div', { class: 'loadmore' });
    const board = h('div', { class: 'kanban' });
    const body = h('div');
    // wide screens: the list stays on the left and the open conversation sits on the right (no overlay)
    const dockEmpty = () => empty('No conversation open', 'Pick a lead on the left. Open one from To call to go through the leads to call one after the other. Press ? for keyboard shortcuts.');
    const dock = h('aside', { class: 'convsplit__dock', 'aria-label': 'Open conversation' }, dockEmpty());
    let selected = null;
    const markSelected = () => main.querySelectorAll('.rcard[data-id]').forEach((el) => { const on = el.dataset.id === selected; el.classList.toggle('is-selected', on); if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); });
    const docked = () => view === 'list' && window.matchMedia('(min-width: 1280px)').matches;
    const productOpts = state.status.products.filter((p) => p !== GENERAL).map((p) => [p, p]);
    const bar = filterBar({
      id: 'conversations', search: 'Search name, company, message or remark…', compact: true,
      // the tab a role starts on: callers on the leads still to call, everyone else on all leads
      seg: { key: 'lead', label: 'Show', options: LEAD_TABS, def: manager ? '' : 'uncalled', chip: false },
      filters: [{ key: 'lstatus', label: 'Call result', options: LEAD_STATUSES.map((st) => [st, leadName(st)]), multi: true },
        { key: 'product', label: 'Product', options: productOpts, multi: true },
        { key: 'status', label: 'Chat status', options: [['open', 'Open'], ['closed', 'Chat closed'], ['ended', 'Ended by DES']], multi: true },
        { key: 'days', label: 'Started', options: DAY_OPTS }],
      toggles: [{ key: 'empty', label: 'Include return visits with nothing sent', chip: 'Including empty return visits', def: false }],
      sort: { options: [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['followup', 'Needs follow-up first'], ['questions', 'Most questions']], def: 'newest' },
      views: [{ label: 'My call list (not called yet, oldest first)', state: { lead: 'uncalled', sort: 'oldest' } }, { label: 'New this week', state: { days: '7' } }, { label: 'Demo requests', state: { lead: '', q: 'demo' } }],
      onChange: () => load(),
    });
    const params = (extra = {}) => {
      const s = bar.state, p = new URLSearchParams();
      if (s.q) p.set('q', s.q); if (s.status.length) p.set('status', s.status.join(',')); if (s.product.length) p.set('product', s.product.join(','));
      if (s.days) p.set('days', s.days); if (s.empty) p.set('all', '1'); if (s.sort) p.set('sort', s.sort);
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return p;
    };
    // a lead opened from the To call tab works as the call list: Previous / Next, and on to the next lead after a call
    const openFromList = (id, callList = view === 'list' && bar.state.lead === 'uncalled') => openConversation(id, { ids: () => items.map((x) => x.id), callList,
      dock: docked() ? dock : null, onOpen: (cid) => { selected = cid; markSelected(); main.querySelector(`.rcard[data-id="${cid}"]`)?.scrollIntoView?.({ block: 'nearest' }); },
      onClose: () => { selected = null; markSelected(); dock.replaceChildren(dockEmpty()); } });
    async function loadCounts() {
      const p = params(); p.delete('sort');
      try { const c = await api('/admin/conversation-counts?' + p); bar.setCounts({ ...c, uncalled: c.tocall ?? c.uncalled }); } catch { }
    }
    async function loadList({ append = false, quiet = false } = {}) {
      const my = ++seq;
      if (!append && !quiet) { listEl.replaceChildren(skelLines(4)); moreBox.replaceChildren(); }
      const p = params({ limit: append ? PAGE : Math.max(PAGE, quiet ? items.length : 0), offset: append ? items.length : 0 });
      // the To call tab asks for the call queue: not called yet, plus call-backs and follow-ups that are due
      const leadParam = bar.state.lstatus.length ? bar.state.lstatus.join(',') : bar.state.lead === 'uncalled' ? 'tocall' : bar.state.lead;
      if (leadParam) p.set('lead', leadParam);
      let rows; try { const r = await api('/admin/conversations?' + p, { raw: true }); total = Number(r.headers.get('x-total-count')) || 0; rows = await r.json(); } catch (e) { return fail(e); }
      if (my !== seq) return;
      if (!append) { items = []; listEl.replaceChildren(); }
      items.push(...rows); listEl.append(...rows.map((c) => convCard(c, openFromList))); markSelected();
      const noun = 'leads';
      bar.setResult(bar.activeLabels().length ? `${n(total)} ${noun} match` : '');
      if (!items.length) listEl.replaceChildren(zeroState(bar, 'No leads match'));
      moreBox.replaceChildren(items.length < total ? h('button', { class: 'btn btn--ghost', type: 'button', text: `Show ${Math.min(PAGE, total - items.length)} more`, on: { click: () => loadList({ append: true }) } }) : null);
    }
    if (typeof IntersectionObserver === 'function') {
      let busy = false;
      new IntersectionObserver(async (entries) => {
        if (!entries.some((e) => e.isIntersecting) || busy || !moreBox.isConnected || !moreBox.querySelector('button')) return;
        busy = true; try { await loadList({ append: true }); } finally { busy = false; }
      }, { rootMargin: '200px' }).observe(moreBox);
    }
    async function loadPipeline() {
      const my = ++seq;
      if (!board.childElementCount) board.replaceChildren(...LEAD_STATUSES.map(() => h('div', { class: 'kcol' }, skelLines(2))));
      let cols; try {
        cols = await Promise.all(LEAD_STATUSES.map(async (st) => { const r = await api('/admin/conversations?' + params({ lead: st, limit: 100 }), { raw: true }); return { st, total: Number(r.headers.get('x-total-count')) || 0, rows: await r.json() }; }));
      } catch (e) { return fail(e); }
      if (my !== seq) return;
      items = cols.flatMap((x) => x.rows);
      bar.setResult(`${n(cols.reduce((a, x) => a + x.total, 0))} leads`);
      board.replaceChildren(...cols.map(({ st, total: t, rows }) => {
        const col = h('section', { class: 'kcol kcol--' + st, 'data-status': st, 'aria-label': `${leadName(st)}: ${t}` },
          h('header', { class: 'kcol__head' }, leadBadge(st), h('span', { class: 'kcol__n', text: n(t) })),
          h('div', { class: 'kcol__body' }, rows.length ? rows.map(kanbanCard) : h('p', { class: 'kcol__empty', text: can('leads.status') && st !== 'new' ? 'Drag a lead here' : 'Nothing here' })),
          t > rows.length ? h('p', { class: 'note', text: `Showing ${rows.length} of ${t}. Narrow the filters to see the rest.` }) : null);
        if (can('leads.status') && st !== 'new') { // New is where leads start, never a place to move them
          col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('is-over'); });
          col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('is-over'); });
          col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('is-over'); const c = items.find((x) => x.id === e.dataTransfer.getData('text/plain')); if (c && c.lead_status !== st) moveLead(c, st); });
        }
        return col;
      }));
    }
    const kanbanCard = (c) => {
      const card = convCard(c, openFromList, { kanban: true });
      if (can('leads.status')) {
        card.draggable = true;
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('is-drag'); });
        card.addEventListener('dragend', () => card.classList.remove('is-drag'));
        card.querySelector('.rcard__top').append(menuBtn(CHOOSABLE_STATUSES.filter((s) => s !== c.lead_status).map((s) => ({ label: 'Move to ' + leadName(s), onClick: () => moveLead(c, s) })), `Move ${c.name}`));
      }
      return card;
    };
    async function moveLead(c, st) {
      const prev = c.lead_status;
      try {
        await setLeadStatus(c.lead_id, st); loadPipeline(); loadCounts();
        toast(`${c.name}: ${leadName(st)}`, false, { undo: async () => { await setLeadStatus(c.lead_id, prev); loadPipeline(); loadCounts(); } });
      } catch (e) { fail(e); }
    }
    const load = () => {
      loadCounts();
      bar.segBox.hidden = view === 'pipeline';
      if (view === 'pipeline') { body.replaceChildren(board); board.replaceChildren(); loadPipeline(); }
      else { body.replaceChildren(listEl, moreBox); loadList(); }
    };
    // no "Start call list" button: the To call tab is the call list (see openFromList)
    const headTools = h('div', { class: 'top__tools' });
    const setView = (v) => {
      view = v; store.set('des:convView', v); main.querySelector('.convsplit')?.classList.toggle('is-board', v === 'pipeline');
      const more = [
        manager && can('leads.view') ? { label: view === 'pipeline' ? 'List view' : 'Pipeline view', hint: view === 'pipeline' ? 'Back to the list' : 'Leads in columns by status', onClick: () => { setView(view === 'pipeline' ? 'list' : 'pipeline'); load(); } } : null,
        can('leads.export') ? { label: 'Download leads CSV', hint: 'Every lead with contact details', onClick: downloadLeads } : null,
      ].filter(Boolean);
      headTools.replaceChildren(
        view === 'pipeline' ? h('button', { class: 'btn', type: 'button', 'data-view': 'list', text: '← Back to list', on: { click: () => { setView('list'); load(); } } }) : null,
        more.length ? menuBtn(more, 'More') : null);
    };
    setView(view);
    // live: new chats / messages / leads / remarks refresh the list in place; the dot marks chats active right now
    const reload = debounce(() => { loadCounts(); if (view === 'pipeline') loadPipeline(); else loadList({ quiet: true }); }, 800);
    live.page = (type) => {
      if (type === 'presence') main.querySelectorAll('.rcard[data-id]').forEach((el) => el.classList.toggle('is-live', live.active.has(el.dataset.id)));
      else if (['conversation.new', 'conversation.update', 'message.new', 'lead.update', 'remark.new', 'remark.deleted'].includes(type)) reload();
    };
    main.replaceChildren(
      h('div', { class: 'top' }, h('div', null, h('h1', { text: 'Conversations & leads' })), headTools),
      h('div', { class: 'convsplit' + (view === 'pipeline' ? ' is-board' : '') },
        h('section', { class: 'card card--list convsplit__list' }, h('div', { class: 'card__head card__head--bar' }, bar.el), h('div', { class: 'card__body convsplit__scroll' }, body)),
        dock),
    );
    load();
  }

  // ---------------- remarks (call notes) ----------------
  function remarksBlock(conversationId, initial, onLeadChange) {
    const list = h('div', { class: 'remarks' });
    const render = (rows) => list.replaceChildren(...(rows.length ? rows.map((r) => h('div', { class: 'remark', 'data-id': r.id },
      avatar(r.user_name || r.user_email || 'Team', 'avatar--xs'),
      h('div', { class: 'remark__main' },
        h('div', { class: 'remark__body', text: r.body }),
        h('div', { class: 'note' }, `${r.user_name || r.user_email || 'Team'} · ${when(r.created_at)}`,
          (r.user_id === state.me.id || state.me.role === 'superuser') ? h('button', { class: 'link-btn', type: 'button', text: 'Delete', style: { marginLeft: '8px' }, on: { click: async () => {
            if (!await ask('The remark is removed for everyone, including on shared links.', { title: 'Delete this remark?', ok: 'Delete' })) return;
            try { await api('/admin/remarks/' + r.id, { method: 'DELETE' }); remove(r.id); } catch (e) { fail(e); }
          } } }) : null)))) : []));
    let rows = initial.slice(); render(rows);
    const ta = h('textarea', { class: 'input', rows: 2, placeholder: 'What happened on the call? e.g. Spoke with Ana, wants a demo next week.', 'aria-label': 'Remark', maxLength: 2000 });
    const save = async () => {
      const body = ta.value.trim(); if (!body) return toast('Write a remark first', true);
      // the live "remark.new" event can arrive before this response: add() ignores a remark that is already listed
      try { const r = await api(`/admin/conversations/${conversationId}/remarks`, { method: 'POST', body: { body } }); add(r); ta.value = ''; toast('Remark saved'); onLeadChange?.(); } catch (e) { fail(e); }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
    const add = (r) => { if (!rows.some((x) => Number(x.id) === Number(r.id))) { rows.push(r); render(rows); } };
    const remove = (rid) => { rows = rows.filter((x) => Number(x.id) !== Number(rid)); render(rows); };
    // the form stays folded into one "Add a note…" line until it is needed
    const form = can('remarks.add') ? h('div', { class: 'remark-form' },
      h('button', { class: 'remark-form__open', type: 'button', text: 'Add a note about the call…', on: { click: () => { form.classList.add('is-open'); ta.focus(); } } }),
      h('div', { class: 'remark-form__full' },
        ta, h('div', { class: 'remark-form__foot' },
          h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Save remark', on: { click: async () => { await save(); if (!ta.value) form.classList.remove('is-open'); } } }),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Cancel', on: { click: () => { ta.value = ''; form.classList.remove('is-open'); } } }),
          h('span', { class: 'note', text: 'Ctrl + Enter saves' })))) : null;
    const box = h('section', { class: 'card remarks-card' },
      h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Notes' }))),
      h('div', { class: 'card__body' }, list, form));
    return { box, add, remove };
  }

  /** Messages in the order the visitor saw them. Grey bubbles: scripted widget messages (sign-up, survey, notices). */
  function renderThread(messages, { goldenById = {}, thumbs = {}, reasons = {}, canSave = false }) {
    let lastUser = null;
    const thread = h('div', { class: 'thread' });
    for (const m of messages) {
      const script = m.kind === 'script';
      if (m.role === 'user') {
        if (!script) lastUser = m;
        thread.append(h('div', { class: 'msg msg--user' + (script ? ' msg--script' : '') }, h('div', { class: 'msg__b', text: m.content }),
          h('div', { class: 'msg__meta' }, m.product ? productChip(m.product) : null, script ? badge('sign-up / choice') : null, when(m.created_at))));
      } else if (m.role === 'assistant') {
        const q = lastUser;
        const used = (m.golden_ids || []).map((gid) => goldenById[String(gid)]).filter(Boolean);
        if (m.author) { thread.append(h('div', { class: 'msg msg--assistant msg--agent' }, h('div', { class: 'msg__b', text: m.content }), h('div', { class: 'msg__meta' }, badge(m.author + ' · team', 'badge--info'), when(m.created_at)))); continue; }
        thread.append(h('div', { class: 'msg msg--assistant' + (script ? ' msg--script' : '') },
          h('div', { class: 'msg__b', html: fmt(m.content || (m.incomplete ? '(nothing shown yet)' : '')) }),
          m.original_content ? h('details', { class: 'msg__orig' }, h('summary', { text: m.blocked_reason ? 'Original reply (replaced by a guardrail)' : 'Original reply (edited by a guardrail)' }), h('div', { html: fmt(m.original_content) })) : null,
          h('div', { class: 'msg__meta' }, when(m.created_at),
            script ? badge('widget message') : null,
            m.incomplete ? badge(m.delivered === false ? 'Cut short: visitor left' : 'Cut short: error', 'badge--bad') : null,
            !m.incomplete && m.delivered === false ? badge('Not delivered: visitor left', 'badge--bad') : null,
            used.map((g) => badge('Approved: ' + g.question.slice(0, 40) + (g.question.length > 40 ? '…' : ''), 'badge--good')),
            m.blocked_reason && !['visitor_left', 'error'].includes(m.blocked_reason) ? badge(blockLabel(m.blocked_reason), 'badge--bad') : null,
            thumbs[m.id] === 1 ? ibadge('up', 'Liked', 'badge--good') : thumbs[m.id] === -1 ? ibadge('down', reasons[m.id] || 'Disliked', 'badge--bad') : null,
            canSave && q && !script && !m.incomplete ? h('button', { class: 'link-btn', type: 'button', text: 'Save as approved answer', on: { click: () => openGolden({ question: q.content, ideal_answer: m.content, product: m.product || q.product || GENERAL, message_id: Number(m.id) }) } }) : null)));
      } else if (m.role === 'tool') {
        const [ic, label] = { save_lead: ['flag', 'Saved lead details'], book_demo: ['calendar', 'Booked a demo request'], search_kb: ['search', 'Searched the website'], get_open_jobs: ['briefcase', 'Looked up open jobs'] }[m.tool_name] || ['dot', m.tool_name];
        thread.append(h('div', { class: 'msg msg--tool' }, icon(ic), label));
      } else if (m.role === 'system') {
        thread.append(h('div', { class: 'msg msg--event', text: m.content }));
      }
    }
    return thread;
  }

  /** Statuses a person may set by hand (More menu, Pipeline). Not called yet is where every lead starts, so it is never chosen. */
  const CHOOSABLE_STATUSES = LEAD_STATUSES.filter((st) => st !== 'new');
  /** What happened on the call: one click records it (remark + status + next call). Keys 1–6 press the buttons. */
  const OUTCOMES = [['qualified', 'Qualified', 'check'], ['callback', 'Call again', 'clock'], ['not_interested', 'Not interested', 'x'], ['no_answer', 'No answer', 'phone'], ['wrong_number', 'Wrong number', 'ban']];
  const localInput = (d) => { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const atHour = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); if (d.getDay() === 0) d.setDate(d.getDate() + 1); return d; };
  function callOutcomes(conversationId, lead, { onSaved } = {}) {
    let st = { ...lead }, busy = false;
    const statusLine = h('div', { class: 'lead-status' });
    const drawStatus = () => {
      const next = nextCallText(st.status, st.next_action_at);
      statusLine.replaceChildren(leadBadge(st.status),
        next ? h('span', { class: next.due ? 'is-warn' : '', text: next.label }) : null,
        st.attempts ? h('span', { text: plural(st.attempts, 'unanswered call') }) : null,
        st.status === 'not_interested' && st.lost_reason ? h('span', { text: st.lost_reason }) : null,
        st.status === 'not_interested' && !reopened && can('leads.status') ? h('button', { class: 'link-btn', type: 'button', text: 'Log another call', on: { click: () => { reopened = true; drawStatus(); } } }) : null);
      pad.hidden = st.status === 'not_interested' && !reopened;
    };
    const step = h('div', { class: 'outcome__step', hidden: true });
    let reopened = false;
    const pad = h('div', { class: 'outcome__pad' });
    const buttons = OUTCOMES.map(([key, label, ic], i) => h('button', { class: 'outcome', type: 'button', 'data-outcome': key, title: `${label} (key ${i + 1})`, disabled: !can('leads.status'),
      on: { click: () => choose(key) } }, h('kbd', { text: String(i + 1) }), icon(ic), label));
    const reset = () => { step.hidden = true; step.replaceChildren(); buttons.forEach((b) => b.classList.remove('is-on')); };
    async function save(key, extra = {}) {
      if (busy) return; busy = true;
      try {
        const r = await api(`/admin/conversations/${conversationId}/outcome`, { method: 'POST', body: { outcome: key, ...extra } });
        st = { ...st, ...r.lead }; reopened = false; drawStatus(); reset();
        toast(r.remark.body.split('. ')[0], false, { undo: async () => {
          const u = await api(`/admin/conversations/${conversationId}/outcome/undo`, { method: 'POST', body: { remark_id: r.remark.id, previous: r.previous } });
          st = { ...st, ...(u.lead || r.previous) }; drawStatus();
        } });
        onSaved?.(r);
      } catch (e) { fail(e); } finally { busy = false; }
    }
    // the extra bit some outcomes need (when, which date, why), then a note and Save; Enter saves, Esc cancels
    function choose(key) {
      buttons.forEach((b) => b.classList.toggle('is-on', b.dataset.outcome === key));
      if (key === 'qualified' || key === 'no_answer' || key === 'wrong_number') { save(key); return; }
      const note = h('input', { class: 'input input--sm', type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Note', maxLength: 500 });
      let pick = { at: null, reason: '' }, extra = [];
      const timeInput = (d) => { const i = h('input', { class: 'input input--sm', type: 'datetime-local', value: localInput(d), 'aria-label': 'Date and time' }); pick.at = d; i.addEventListener('input', () => { pick.at = i.value ? new Date(i.value) : null; }); return i; };
      const presets = (list, def) => {
        const box = h('div', { class: 'chips' }), custom = h('div');
        const draw = (sel) => box.replaceChildren(...list.map(([label, d], i) => h('button', { type: 'button', class: 'chip' + (i === sel ? ' is-on' : ''), text: label, 'aria-pressed': String(i === sel),
          on: { click: () => { draw(i); if (d) { pick.at = d; custom.replaceChildren(); } else custom.replaceChildren(timeInput(atHour(1, 9))); } } })));
        draw(def); pick.at = list[def][1];
        return [box, custom];
      };
      const now = new Date();
      if (key === 'callback') extra = presets([['In 1 hour', new Date(Date.now() + 3600e3)], ...(now.getHours() < 14 ? [['This afternoon, 3 PM', atHour(0, 15)]] : []), ['Tomorrow, 9 AM', atHour(1, 9)], ['Pick a time…', null]], 0);
      else if (key === 'not_interested') {
        const box = h('div', { class: 'chips' });
        const draw = (sel) => box.replaceChildren(...['Price', 'Already has a system', 'Not now', 'Other'].map((r) => h('button', { type: 'button', class: 'chip' + (r === sel ? ' is-on' : ''), text: r, 'aria-pressed': String(r === sel), on: { click: () => { pick.reason = r === pick.reason ? '' : r; draw(pick.reason); } } })));
        draw(''); extra = [h('span', { class: 'note', text: 'Why? (optional)' }), box];
      }
      const go = () => {
        if (key === 'callback' && !pick.at) return toast('Pick when to call again', true);
        save(key, { note: note.value.trim() || undefined, at: pick.at ? pick.at.toISOString() : undefined, reason: pick.reason || undefined });
      };
      note.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') { e.stopPropagation(); reset(); } });
      step.replaceChildren(...extra, h('div', { class: 'outcome__row' }, note,
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Save', on: { click: go } }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Cancel', on: { click: reset } })));
      step.hidden = false; note.focus();
    }
    drawStatus();
    return {
      el: h('div', { class: 'outcomes' }, statusLine,
        can('leads.status') ? (pad.append(h('div', { class: 'outcome__label', text: 'What happened on the call?' }), h('div', { class: 'outcome__grid' }, h('span', { class: 'outcome__group', text: 'Spoke with them' }), buttons.slice(0, 3), h('span', { class: 'outcome__group', text: 'Couldn’t reach them' }), buttons.slice(3)), step), pad) : null),
      get status() { return st.status; },
      setLead(l) { st = { ...st, ...l }; drawStatus(); },
      press(i) { if (!pad.hidden) buttons[i]?.click(); },
    };
  }

  /** Conversation in a side drawer, or docked in ctx.dock beside the list on wide screens.
   *  ctx.ids() = the list behind it, for Previous / Next (call list); ctx.onOpen / ctx.onClose keep the list's selection in step. */
  async function openConversation(id, ctx = {}) {
    const dockEl = ctx.dock?.isConnected ? ctx.dock : null;
    const close = dockEl ? () => { live.drawer = null; ctx.onClose?.(); } : closeLayer;
    const body = h('div', { class: 'drawer__body' }, skelLines(3));
    const head = h('div', { class: 'drawer__head' }, h('h2', { text: 'Conversation' }), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: close } }, icon('x')));
    const panelEl = h('div', { class: 'drawer' + (dockEl ? ' drawer--docked' : ''), role: dockEl ? 'region' : 'dialog', 'aria-modal': dockEl ? null : 'true', 'aria-label': 'Conversation' }, head, body);
    if (dockEl) { live.drawer = null; dockEl.replaceChildren(panelEl); } else openLayer(panelEl);
    ctx.onOpen?.(id);
    let c; try { c = await api(`/admin/conversations/${id}/detail`); } catch (e) { close(); return fail(e); }
    if (!panelEl.isConnected) return; // another conversation was opened while this one loaded
    const goldenById = Object.fromEntries(c.golden.map((g) => [String(g.id), g]));
    const thumbs = {}; c.feedback.filter((f) => f.kind === 'thumb' && f.message_id).forEach((f) => { thumbs[f.message_id] = f.thumb; });
    const reasons = {}; c.feedback.filter((f) => f.kind === 'thumb_reason' && f.message_id).forEach((f) => { reasons[f.message_id] = (f.reasons || []).join(', '); });
    // previous / next through the list this was opened from
    const ids = ctx.ids?.() || [], idx = ids.indexOf(id);
    const nav = ctx.callList && idx >= 0 && ids.length > 1 ? h('div', { class: 'drawer__nav' },
      h('button', { class: 'btn btn--sm', type: 'button', text: '‹ Previous', disabled: idx === 0, on: { click: () => openConversation(ids[idx - 1], ctx) } }),
      h('span', { class: 'note', text: `${idx + 1} of ${ids.length}` }),
      h('button', { class: 'btn btn--sm', type: 'button', text: 'Next ›', disabled: idx === ids.length - 1, on: { click: () => openConversation(ids[idx + 1], ctx) } })) : null;
    const reach = (value, href, label, type) => value ? h('span', { class: 'reach' }, h('a', { href, text: value, title: label === 'Mobile' ? 'Call ' + value : 'Email ' + value }), contactBadge(type),
      h('button', { class: 'reach__copy', type: 'button', 'aria-label': 'Copy ' + label.toLowerCase(), title: 'Copy', on: { click: () => copyText(value, label + ' copied') } }, icon('copy'))) : null;
    head.replaceChildren(
      h('div', { class: 'drawer__who' }, h('div', null, h('h2', { text: displayName(c.name) }),
        h('div', { class: 'drawer__reach' },
          reach(c.phone, c.phone ? 'tel:' + c.phone.replace(/[^\d+]/g, '') : null, 'Mobile', c.phone_type),
          reach(c.email, c.email ? 'mailto:' + c.email : null, 'Email', c.email_type),
          c.status === 'ended' ? statusBadge(c.status) : null, c.lang === 'fil' ? badge('Filipino') : null))),
      h('div', { class: 'drawer__tools' }, nav,
        can('share.create') || can('visitors.delete') ? menuBtn([
          can('share.create') ? { label: 'Create share link…', hint: 'A read-only page anyone with the link can open', onClick: () => openShare(id, c.name, loadShares) } : null,
          can('visitors.delete') ? { label: 'Delete this visitor’s data…', hint: 'For Data Privacy Act erasure requests', danger: true, onClick: deleteVisitor } : null,
        ], 'More actions for this conversation') : null,
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: close } }, icon('x'))));
    async function deleteVisitor() {
      if (!await ask(`${c.name}'s details, chats and lead are deleted for good. Use this for Data Privacy Act erasure requests. This cannot be undone.`, { title: 'Delete this visitor’s data?', ok: 'Delete permanently' })) return;
      try { await api('/admin/visitors/' + c.visitor_id, { method: 'DELETE' }); toast('Visitor data deleted'); close(); route(); } catch (e) { fail(e); }
    }
    const thread = renderThread(c.messages, { goldenById, thumbs, reasons, canSave: can('finetune.manage') });
    // the chat starts at its last few messages; the rest is one click away
    const SHOW = 4, early = [...thread.children].slice(0, -SHOW);
    if (early.length > 1) {
      early.forEach((el) => el.classList.add('is-early'));
      thread.classList.add('is-clipped');
      thread.prepend(h('button', { class: 'thread__more', type: 'button', text: `Show the whole chat (${early.length} earlier messages)`,
        on: { click: (e) => { thread.classList.remove('is-clipped'); e.currentTarget.remove(); } } }));
    }
    const tabs = h('div', { class: 'ptabs', role: 'tablist' });
    const panel = h('div', { role: 'tabpanel' }, thread);
    if (c.other_conversations > 0) {
      const tab = (key, label, show) => h('button', { type: 'button', role: 'tab', 'data-tab': key, class: key === 'this' ? 'is-on' : null, text: label, on: { click: async (e) => {
        tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === e.currentTarget)); await show(); } } });
      tabs.append(tab('this', 'This conversation', () => panel.replaceChildren(thread)),
        tab('history', `Visitor history (${c.other_conversations + 1} chats)`, async () => {
          panel.replaceChildren(skelLines(2));
          let hst; try { hst = await api(`/admin/conversations/${id}/history`); } catch (e) { return fail(e); }
          // one row per visit (newest first); the chat opens when the row is clicked
          panel.replaceChildren(h('div', { class: 'history-list' }, [...hst.conversations].reverse().map((cv) => {
            const said = cv.messages.filter((m) => m.role === 'user' && m.kind === 'chat');
            const first = said[0]?.content || cv.messages.find((m) => m.role === 'user')?.content || '';
            const hb = h('div', { class: 'history-conv__body' });
            const d = h('details', { class: 'history-conv' + (cv.id === id ? ' is-current' : ''), on: { toggle: () => { if (d.open && !hb.childElementCount) hb.append(cv.messages.length ? renderThread(cv.messages, {}) : h('p', { class: 'muted', text: 'Opened the chat, sent nothing.' })); } } },
              h('summary', null,
                h('span', { class: 'history-conv__when', text: when(cv.started_at) }), statusBadge(cv.status), cv.id === id ? badge('This conversation', 'badge--brand') : null,
                h('span', { class: 'muted', text: plural(said.length, 'message') }),
                h('div', { class: 'history-conv__first clip', text: cv.summary || first || '(no messages)', title: cv.summary || first })),
              hb);
            return d;
          })));
        }));
    }
    if (!c.messages.length) thread.append(empty('No messages', 'The visitor opened the chat but did not send anything.'));
    // live: messages appear as they are sent; "{name} is typing…" while the visitor types (start / stop only, never the text)
    const typingEl = h('div', { class: 'typing-line', hidden: true, 'aria-live': 'polite' });
    let typingTimer = null;
    // share link: a read-only page without sign-in, e.g. for a manager
    const shareBox = h('div', { class: 'share-list' });
    async function loadShares() {
      if (!can('share.create')) return;
      let links; try { links = await api('/admin/shares?conversation_id=' + id); } catch (e) { return fail(e); }
      shareBox.replaceChildren(...links.map((l) => h('div', { class: 'share-row' },
        h('span', { class: 'muted', text: `Link by ${l.created_by_email || '—'} · expires ${untilText(l.expires_at)} · opened ${l.view_count}×` }),
        h('button', { class: 'link-btn', type: 'button', text: 'Revoke', on: { click: async () => { if (!await ask('Anyone who has the link can no longer open the conversation.', { title: 'Revoke this share link?', ok: 'Revoke link' })) return; try { await api('/admin/shares/' + l.id, { method: 'DELETE' }); toast('Link revoked'); loadShares(); } catch (e) { fail(e); } } } }))));
    }
    loadShares();
    const lead = c.lead;
    // after recording a call during the call list, go on to the next lead by itself (3 s, "Stay here" cancels)
    const advance = h('div', { class: 'advance', hidden: true, role: 'status' });
    const nextId = () => { const list = ctx.ids?.() || []; const i = list.indexOf(id); return i >= 0 ? list[i + 1] : null; };
    const calls = lead ? callOutcomes(id, lead, { onSaved: () => {
      if (!ctx.callList) return;
      const nid = nextId();
      if (!nid) { advance.hidden = false; advance.replaceChildren(h('span', { text: 'That was the last lead in this list.' })); return; }
      let timer = null, left = 3;
      const tick = () => { advance.replaceChildren(h('span', { text: `Next lead in ${left} s` }), h('button', { class: 'link-btn', type: 'button', text: 'Go now', on: { click: () => { clearInterval(timer); openConversation(nid, ctx); } } }),
        h('button', { class: 'link-btn', type: 'button', text: 'Stay here', on: { click: () => { clearInterval(timer); advance.hidden = true; } } })); };
      advance.hidden = false; tick();
      timer = setInterval(() => { left--; if (!advance.isConnected || advance.hidden) return clearInterval(timer); if (left <= 0) { clearInterval(timer); openConversation(nid, ctx); } else tick(); }, 1000);
    } }) : null;
    const rem = remarksBlock(id, c.remarks || [], () => { if (calls && calls.status === 'new') calls.setLead({ status: 'contacted' }); });
    // keyboard: 1–6 outcome · N note · J / K next / previous · ? help (see the global key handler)
    activePanel = { el: panelEl, press: (i) => calls?.press(i), note: () => { rem.box.querySelector('.remark-form__open')?.click(); },
      move: (step) => { const list = ctx.ids?.() || []; const i = list.indexOf(id); const t = list[i + step]; if (i >= 0 && t) openConversation(t, ctx); } };
    live.drawer = (type, d) => {
      if ((d.conversation_id || d.id) !== id && d.conversation_id !== id) return;
      if (type === 'message.new') {
        thread.querySelector(':scope > .empty')?.remove();
        thread.append(...renderThread([d], { goldenById, thumbs, reasons, canSave: false }).childNodes);
        if (d.role === 'user') typingEl.hidden = true;
      } else if (type === 'typing') {
        clearTimeout(typingTimer);
        typingEl.textContent = `${d.name || 'The visitor'} is typing…`;
        typingEl.hidden = d.state !== 'start';
        if (d.state === 'start') typingTimer = setTimeout(() => { typingEl.hidden = true; }, d.expires_ms || 6000);
      } else if (type === 'remark.new') rem.add(d);
      else if (type === 'remark.deleted') rem.remove(d.id);
      else if (type === 'lead.update' && calls && d.status) calls.setLead(d);
      else if (type === 'conversation.update' && 'agent_id' in d) { agent = { id: d.agent_id, name: d.agent_name }; drawTk(); }
      else if (type === 'presence') drawTk();
    };
    // ---- live takeover ----
    let agent = { id: c.agent_id || null, name: c.agent_name || null };
    const first = displayName(c.name).split(' ')[0];
    const tk = h('div', { class: 'takeover', hidden: true, role: 'status' });
    const replyBox = h('textarea', { class: 'input', rows: 2, maxLength: 2000, placeholder: `Write to ${first}… (Enter sends, Shift + Enter for a new line)`, 'aria-label': 'Message to the visitor' });
    const sendReply = async () => {
      const text = replyBox.value.trim(); if (!text) return;
      try { await api(`/admin/conversations/${id}/reply`, { method: 'POST', body: { text } }); replyBox.value = ''; } catch (e) { fail(e); }
    };
    replyBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } });
    const composer = h('div', { class: 'takeover__compose', hidden: true }, replyBox, h('button', { class: 'btn btn--primary', type: 'button', text: 'Send', on: { click: sendReply } }));
    const takeOver = async () => {
      try { const r = await api(`/admin/conversations/${id}/takeover`, { method: 'POST', body: {} }); agent = { id: r.agent_id, name: r.agent_name }; drawTk(); replyBox.focus(); toast(`You're chatting with ${first}. DES is paused.`); } catch (e) { fail(e); }
    };
    const handBackDes = async () => {
      try { await api(`/admin/conversations/${id}/handback`, { method: 'POST', body: {} }); agent = { id: null, name: null }; drawTk(); toast('DES is answering again'); } catch (e) { fail(e); }
    };
    function drawTk() {
      const mine = agent.id && agent.id === state.me.id, liveNow = live.active.has(id), may = can('chats.takeover');
      composer.hidden = !mine;
      let parts = null;
      if (mine) parts = [h('span', { class: 'takeover__live', text: 'Live' }), h('span', { text: `You're chatting with ${first}. DES is paused.` }), h('span', { class: 'sp' }), h('button', { class: 'btn btn--sm', type: 'button', text: 'Hand back to DES', on: { click: handBackDes } })];
      else if (agent.id) parts = [h('span', { text: `${agent.name} is chatting with ${first}. DES is paused.` }), h('span', { class: 'sp' }), may ? h('button', { class: 'btn btn--sm', type: 'button', text: `Take over from ${agent.name}`, on: { click: takeOver } }) : null];
      else if (liveNow && c.status !== 'ended' && may) parts = [h('span', { class: 'takeover__live', text: 'On the website now' }), h('span', { class: 'sp' }), h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Take over chat', on: { click: takeOver } })];
      tk.hidden = !parts; tk.replaceChildren(...(parts || []));
    }
    drawTk();
    // what they want, in one place: their own words, then products / demo / company as one line
    const wants = lead ? [
      lead.need && !/^demo requested\.?$/i.test(lead.need.trim()) ? lead.need : null,
    ].filter(Boolean) : [];
    const about = lead ? [(lead.product_interest || []).join(', '), lead.demo_requested ? 'Wants a demo' : null,
      [realValue(lead.company), realValue(lead.industry), lead.team_size && lead.team_size + ' people'].filter(Boolean).join(', ')].filter(Boolean) : [];
    const details = [
      ['Started', when(c.started_at)],
      c.summary && !/^Sample chat|^Imported lead/.test(c.summary) ? ['Summary', c.summary] : null,
      lead?.current_system ? ['Uses now', lead.current_system] : null,
      c.first_page_url ? ['First page', h('a', { class: 'kv__link', href: c.first_page_url, target: '_blank', rel: 'noopener', title: c.first_page_url, text: shortPath(c.first_page_url) })] : null,
      ['Marketing opt-in', c.marketing_opt_in ? 'Yes' : 'No'],
    ].filter(Boolean);
    // two panels: the lead (left, scrolls on its own) and the chat (right: the conversation scrolls, the live controls stay at
    // its bottom edge, so writing to the visitor never needs scrolling). Narrow spaces stack them (CSS container query).
    const threadBox = h('div', { class: 'convo__thread' }, panel, typingEl);
    let pinned = true; // follow new messages while the newest is in view; stop when the person scrolls up to read
    threadBox.addEventListener('scroll', () => { pinned = threadBox.scrollHeight - threadBox.scrollTop - threadBox.clientHeight < 80; });
    const toBottom = () => { if (pinned) threadBox.scrollTop = threadBox.scrollHeight; };
    if (typeof MutationObserver === 'function') new MutationObserver((muts) => {
      if (muts.some((m) => [...m.removedNodes].some((n) => n.classList?.contains('thread__more')))) { pinned = false; return; } // "Show the whole chat": keep reading from the top
      toBottom();
    }).observe(threadBox, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const foot = h('div', { class: 'convo__foot' }, tk, composer);
    body.classList.add('convo');
    body.replaceChildren(
      h('div', { class: 'convo__lead' },
        h('section', { class: 'card drawer__card' }, h('div', { class: 'card__body' },
          wants.length ? h('p', { class: 'lead-box__need', text: wants[0] }) : null,
          about.length ? h('p', { class: 'lead-box__about', text: about.join(' · ') }) : null,
          lead ? [calls.el, advance] : null,
          h('details', { class: 'more-details' }, h('summary', { text: 'Details' }),
            h('dl', { class: 'kv kv--tight' }, details.map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]))))),
        rem.box,
        can('share.create') ? shareBox : null),
      h('section', { class: 'card convo__chat', 'aria-label': 'Chat' },
        h('div', { class: 'convo__chat-head' }, h('h3', { text: 'Chat' }), tabs.children.length ? tabs : null),
        threadBox,
        foot),
    );
    requestAnimationFrame(() => { threadBox.scrollTop = threadBox.scrollHeight; });
  }

  // =====================================================================================
  // Fine-tune answers
  // =====================================================================================
  async function pageFinetune(productArg) {
    const moved = navToken();
    loading();
    try { state.products = await api('/admin/products'); } catch (e) { return moved() ? undefined : fail(e); }
    if (moved()) return;
    const FT_SUB = 'Teach DES per product. Approved answers are used word-for-word in facts and links when a visitor asks something similar; product notes add facts the website doesn’t have yet.';
    if (!productArg || !state.products.some((p) => p.product === productArg)) return finetuneOverview(FT_SUB);
    const current = state.products.find((p) => p.product === productArg);
    // product picker: every product (the list is short and comes from the website), searchable
    let term = '';
    const listBox = h('div', { class: 'plist__items' });
    const item = (p) => h('button', { type: 'button', class: 'plist__item' + (p.product === current.product ? ' is-on' : ''), 'aria-current': p.product === current.product ? 'true' : null,
      on: { click: () => { location.hash = '#/finetune/' + encodeURIComponent(p.product); } } },
      h('span', { class: 'plist__name' + (p.live === false ? ' is-off' : ''), text: p.product === GENERAL ? 'General (all products)' : p.product }),
      p.needs_review ? h('span', { class: 'badge badge--info', title: 'Added from the website. Check the name in Details.', text: 'New' }) : null,
      p.live === false ? h('span', { class: 'badge', title: p.on_website === false ? 'Its page is no longer on the website' : 'Switched off', text: 'Off' }) : null,
      p.thumbs_down ? h('span', { class: 'plist__warn', title: `${p.thumbs_down} disliked answers` }, icon('down'), String(p.thumbs_down)) : null,
      p.questions_30d ? h('span', { class: 'plist__n', title: 'Questions in 30 days', text: n(p.questions_30d) }) : null);
    const drawList = () => {
      const match = state.products.filter((p) => !term || p.product.toLowerCase().includes(term));
      listBox.replaceChildren(...match.map(item),
        !match.length ? h('p', { class: 'muted', style: { padding: '8px 12px', margin: 0 }, text: 'No product matches.' }) : null);
    };
    const find = h('input', { class: 'input input--sm', type: 'search', placeholder: 'Find a product…', 'aria-label': 'Find a product' });
    find.addEventListener('input', debounce(() => { term = find.value.trim().toLowerCase(); drawList(); }, 120));
    drawList();
    const detail = h('div', { class: 'stack' }, skelLines(2));
    main.replaceChildren(
      // no page-level "+ Add approved answer" here: the Approved answers tab has it, next to the answers
      top('Fine-tune answers', FT_SUB, checkProductsButton()),
      h('div', { class: 'ft' }, h('nav', { class: 'card plist', 'aria-label': 'Products' },
        h('a', { class: 'plist__all', href: '#/finetune' }, h('span', { 'aria-hidden': 'true', text: '←' }), 'All products'),
        h('div', { class: 'plist__find' }, find), listBox), detail));
    renderProduct(current.product, detail);
  }

  /** "Check for new products": reads dynamiqes.com/products/ now and adds any product not seen before. */
  function checkProductsButton() {
    const label = h('span', { text: 'Check for new products' });
    const btn = h('button', { class: 'btn', type: 'button', title: 'Read dynamiqes.com/products/ now and add any new product' }, icon('refresh'), label);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.classList.add('is-busy'); label.textContent = 'Checking the website…';
      try {
        const r = await api('/admin/products/check', { method: 'POST' });
        if (!r.ok) toast('Could not check the website: ' + (r.detail || 'unknown error'), true);
        else if (r.added.length) toast(`Added ${r.added.join(', ')} from the website. Check ${r.added.length === 1 ? 'its name' : 'their names'} and add the words visitors use.`);
        else toast(`No new products. ${plural(r.found, 'product')} on the website${r.gone.length ? `; no longer listed: ${r.gone.join(', ')}` : ''}.`);
        state.status = await api('/admin/status').catch(() => state.status);
        if (location.hash.startsWith('#/finetune')) route();
      } catch (e) { fail(e); } finally { btn.disabled = false; btn.classList.remove('is-busy'); label.textContent = 'Check for new products'; }
    });
    return btn;
  }

  /** The product's logo from the website, or its initials when there is none (or it fails to load). */
  function productMark(p, cls = '') {
    const fallback = () => h('span', { class: 'pmark pmark--text ' + cls, 'data-c': String(hashOf(p.product) % 8), 'aria-hidden': 'true', text: p.product === GENERAL ? '★' : initials(p.website_name || p.product) });
    const src = p.logo_url;
    if (!src) return fallback();
    const img = h('img', { class: 'pmark pmark--img ' + cls, src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    return img;
  }
  /** Card picture: the product's image from the website with its logo on top; a tinted block with logo or initials otherwise. */
  function productBanner(p, status) {
    const box = h('div', { class: 'pcard__banner', 'data-c': String(hashOf(p.product) % 8) });
    const logo = () => (p.logo_url ? h('img', { class: 'pcard__logo', src: p.logo_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', on: { error: (e) => e.target.remove() } }) : null);
    if (p.image_url) {
      const img = h('img', { class: 'pcard__img', src: p.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { img.remove(); box.classList.add('is-plain'); if (!box.querySelector('.pcard__logo')) box.prepend(productMark(p, 'pmark--lg')); }, { once: true });
      box.append(img, logo() || '');
    } else {
      box.classList.add('is-plain');
      box.append(p.logo_url ? logo() : productMark(p, 'pmark--lg'));
    }
    if (status) box.append(h('div', { class: 'pcard__status' }, status));
    return box;
  }
  const coverage = (p) => (p.replies_30d ? Math.round((100 * p.covered_30d) / p.replies_30d) : null);

  /** Landing view: every product as a card with how well DES is taught for it. Products come from the website. */
  function finetuneOverview(sub) {
    const chk = state.status?.products_check, every = state.status?.products_check_hours;
    const general = state.products.find((p) => p.product === GENERAL);
    const products = state.products.filter((p) => p.product !== GENERAL);
    const fresh = products.filter((p) => p.needs_review && p.live !== false);
    const order = (p) => (p.needs_review && p.live !== false ? 0 : p.live === false ? 2 : 1);
    const sorted = [...products].sort((a, b) => order(a) - order(b)); // stable: website order inside each group
    const checked = chk?.checked_at
      ? [`Checked dynamiqes.com/products ${ago(chk.checked_at)}`, chk.ok ? `${plural(chk.found ?? products.length, 'product')} listed` : `last check failed: ${chk.detail || 'unknown error'}`]
      : ['Not checked yet'];
    if (every > 0) checked.push(`checks again every ${every} hours`);

    const stat = (value, label, cls = '') => h('div', { class: 'pcard__stat ' + cls }, h('b', { text: value }), h('span', { text: label }));
    const card = (p) => {
      const isGeneral = p.product === GENERAL, pct = coverage(p);
      const status = p.needs_review && p.live !== false ? badge('New from the website', 'badge--info')
        : p.on_website === false ? badge('Page gone') : p.active === false ? badge('Switched off') : null;
      return h('a', { class: 'card pcard' + (p.live === false ? ' is-off' : '') + (p.needs_review && p.live !== false ? ' is-new' : ''), href: '#/finetune/' + encodeURIComponent(p.product),
        'aria-label': `${isGeneral ? 'General (all products)' : p.product}: ${plural(p.approved, 'approved answer')}, ${plural(p.questions_30d, 'question')} in 30 days` },
        productBanner(p, status),
        h('div', { class: 'pcard__body' },
          h('b', { class: 'pcard__name', text: isGeneral ? 'General (all products)' : p.product }),
          h('p', { class: 'pcard__desc', text: isGeneral ? 'Company, contact and demo questions, and answers that fit every product.' : p.description || 'No description on the website yet.' }),
          h('div', { class: 'pcard__stats' },
            stat(n(p.approved), p.approved === 1 ? 'approved answer' : 'approved answers'),
            stat(n(p.questions_30d), 'questions · 30 days'),
            p.thumbs_down ? stat(n(p.thumbs_down), 'disliked', 'is-bad') : stat(isGeneral ? '—' : n(p.leads), 'leads')),
          // only once there are replies to measure: an empty bar on every card is noise
          pct == null ? null : h('div', { class: 'pcard__cover', title: 'Of DES’s replies about this product in the last 30 days, how many used an approved answer' },
            h('div', { class: 'pcard__coverrow' }, h('span', { text: 'Replies from approved answers' }), h('b', { text: pct + '%' })),
            h('div', { class: 'meter' + (pct < 20 ? ' is-warn' : '') }, h('div', { class: 'meter__fill', style: { width: pct + '%' } })))));
    };
    main.replaceChildren(
      top('Fine-tune answers', sub, checkProductsButton(),
        h('button', { class: 'btn btn--primary', type: 'button', text: '+ Add approved answer', on: { click: () => openGolden({}) } })),
      h('p', { class: 'note ftov__checked' }, icon('globe'), checked.join(' · ')),
      fresh.length ? h('div', { class: 'callout ftov__new' }, h('b', { text: `${plural(fresh.length, 'new product')} from the website. ` }),
        'DES already answers questions about ', ...fresh.flatMap((p, i) => [i ? ', ' : '', h('a', { href: '#/finetune/' + encodeURIComponent(p.product), text: p.product })]),
        '. Check the name, add the words visitors use for it, then write a few approved answers.') : null,
      h('div', { class: 'pgrid' }, sorted.map(card), general ? card(general) : null));
  }

  async function renderProduct(name, detail, tab = 'answers') {
    let d; try { d = await api('/admin/products/' + encodeURIComponent(name)); } catch (e) { return fail(e); }
    if (!detail.isConnected) return; // the person left this product while it loaded
    const p = state.products.find((x) => x.product === name) || {};
    const isGeneral = name === GENERAL;
    const tabs = [['answers', 'Approved answers', d.golden.length], ['questions', 'Visitor questions', d.questions.length], ['notes', 'Product notes', null]];
    if (!isGeneral) tabs.push(['pages', 'Website pages', d.docs.length], ['details', p.needs_review ? 'Details ●' : 'Details', null]);
    const panel = h('div', { class: 'card__body', role: 'tabpanel' });
    const show = (key) => { tab = key; panel.replaceChildren(({ answers: tabAnswers, questions: tabQuestions, notes: tabNotes, pages: tabPages, details: tabDetails }[key])(d, name, () => renderProduct(name, detail, tab))); };
    detail.replaceChildren(
      h('section', { class: 'card' },
        h('div', { class: 'card__head' }, h('div', { class: 'ft__title' }, productMark({ ...p, product: name }, 'pmark--lg'),
          h('div', null, h('h2', { text: isGeneral ? 'General (all products)' : name }),
            isGeneral ? h('p', { text: 'Answers here are used for any product, e.g. company, contact or demo questions.' })
              : h('div', null,
                p.description ? h('p', { class: 'ft__desc', text: p.description }) : null,
                h('div', { class: 'ft__links' },
                  p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'View on website', h('span', { 'aria-hidden': 'true', text: ' ↗' })) : h('span', { text: 'No product page' }),
                  h('span', { title: p.page_read_at ? when(p.page_read_at) : null, text: p.page_read_at ? 'page text updated ' + ago(p.page_read_at) : 'page not read yet' }),
                  coverage(p) != null ? h('span', { text: `${coverage(p)}% of replies (30 days) from approved answers` }) : null)))),
          isGeneral ? null : h('div', { class: 'stat-chips' },
            h('span', { class: 'stat-chip' }, h('b', { text: n(p.questions_30d) }), ' questions · 30 days'), h('span', { class: 'stat-chip' }, h('b', { text: n(p.leads) }), ' leads'),
            h('span', { class: 'stat-chip' }, h('b', { text: n(p.chunks) }), ' website passages'), p.thumbs_down ? h('span', { class: 'stat-chip is-bad' }, h('b', { text: n(p.thumbs_down) }), ' disliked') : null)),
        h('div', { class: 'card__body' }, testBox(name))),
      h('section', { class: 'card' }, tabStrip(tabs, tab, show), panel));
    show(p.needs_review && tab === 'answers' && !d.golden.length ? 'details' : tab);
  }

  /** Name, nicknames, product page, on/off. New products come from the website with a guessed name for staff to check. */
  function tabDetails(_d, name) {
    const p = state.products.find((x) => x.product === name) || {};
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: 60, required: true, value: name });
    const aliases = h('textarea', { class: 'input', rows: 4, maxlength: 1200, placeholder: 'payroll\nhris\n13th month' });
    aliases.value = (p.aliases || []).join('\n');
    const url = h('input', { class: 'input', type: 'url', maxlength: 300, value: p.url || '', placeholder: 'https://dynamiqes.com/products/…/' });
    const active = h('input', { type: 'checkbox', checked: p.active !== false });
    const save = h('button', { class: 'btn btn--primary', type: 'submit', text: p.needs_review ? 'Save and mark as checked' : 'Save' });
    const form = h('form', { class: 'stack', on: { submit: async (e) => {
      e.preventDefault(); save.disabled = true;
      try {
        const r = await api('/admin/products/' + encodeURIComponent(name), { method: 'PUT', body: { name: nameIn.value.trim(), aliases: aliases.value, url: url.value.trim(), active: active.checked, reviewed: true } });
        state.status = await api('/admin/status');
        toast(r.name !== name ? `Renamed to ${r.name}. Leads, answers and notes moved with it.` : 'Saved. DES uses it from the next message.');
        const next = '#/finetune/' + encodeURIComponent(r.name);
        location.hash === next ? route() : (location.hash = next);
      } catch (err) {
        const msg = { 'name taken': 'Another product already has that name.', 'page taken': 'Another product already uses that page.', 'bad product page': 'Use a page address under dynamiqes.com/products/, or leave it empty.', 'name reserved': 'That name is reserved. Pick another.', 'name required': 'Enter a name.' }[err.message];
        msg ? toast(msg, true) : fail(err);
      } finally { save.disabled = false; }
    } } },
      p.needs_review ? h('div', { class: 'callout' }, `DES found this product on the website ${p.added_at ? ago(p.added_at) : 'recently'} and named it after the page title. Check the name, add the words visitors use for it, then save. DES already answers questions about it in the meantime.`) : null,
      p.on_website === false ? h('div', { class: 'callout' }, 'This product’s page is no longer on the website, so DES no longer names it. If the page moved, enter its new address below.') : null,
      h('label', { class: 'field' }, h('span', { text: 'Name' }), nameIn, h('small', { text: 'Exactly as DES should write it, e.g. "IQ Barcode". Renaming moves leads, approved answers and notes to the new name.' })),
      h('label', { class: 'field' }, h('span', { text: 'Other words visitors use' }), aliases, h('small', { text: 'One per line. When a visitor uses one of these, DES knows they mean this product (e.g. "payroll" → IQ People). Avoid words that fit several products.' })),
      h('label', { class: 'field' }, h('span', { text: 'Product page' }), url, h('small', { text: 'Its page on the website. Found automatically; change it only if the page moved.' })),
      h('label', { class: 'toggle' }, active, h('span', { class: 'toggle__text', text: 'DES talks about this product' })),
      h('div', null, save));
    return form;
  }

  function testBox(product) {
    const input = h('input', { class: 'input input--lg', type: 'text', placeholder: product === GENERAL ? 'Type a question a visitor might ask…' : `Ask what a visitor might ask about ${product}…`, 'aria-label': 'Test question' });
    const lang = h('select', { class: 'input', 'aria-label': 'Language' }, h('option', { value: 'auto', text: 'Auto language' }), h('option', { value: 'en', text: 'English' }), h('option', { value: 'fil', text: 'Filipino' }));
    const btn = h('button', { class: 'btn btn--primary', type: 'submit', text: 'Ask DES' });
    const out = h('div', { class: 'test__out', 'aria-live': 'polite' });
    const form = h('form', { class: 'test' },
      h('div', { class: 'test__title' }, h('b', { text: 'Test a question' }), h('span', { class: 'note', text: 'Runs the real bot with your current answers and notes. Uses a little AI credit; nothing is saved.' })),
      h('div', { class: 'test__row' }, input, lang, btn), out);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const question = input.value.trim(); if (!question) return input.focus();
      const asked = h('div', { class: 'msg msg--user test__q' }, h('div', { class: 'msg__b', text: question }));
      btn.disabled = true; btn.textContent = 'Asking…'; out.replaceChildren(asked, h('div', { class: 'muted', text: 'DES is thinking…' }));
      try {
        const r = await api('/admin/test', { method: 'POST', body: { question, lang: lang.value, product: product === GENERAL ? 'auto' : product } });
        const urls = [...new Map(r.sources.map((s) => [s.url, s])).values()].slice(0, 4);
        out.replaceChildren(asked,
          h('div', { class: 'bubble', html: fmt(r.answer) }),
          h('div', { class: 'meta-line' },
            r.approved.length ? r.approved.map((a) => badge(`Used approved answer (${Math.round(a.score * 100)}% match): ${a.question.slice(0, 50)}`, 'badge--good')) : badge('No approved answer matched'),
            r.notes_used ? badge('Product notes used', 'badge--info') : null,
            r.blocked ? badge('Changed by safety rules: ' + blockLabel(r.blocked), 'badge--bad') : null,
            productChip(r.product), `${(r.ms / 1000).toFixed(1)} s`),
          urls.length ? h('div', { class: 'sources' }, h('span', { class: 'note', text: 'Website sources' }), urls.map((s) => h('a', { class: 'source', href: s.url, target: '_blank', rel: 'noopener', text: s.title || shortPath(s.url) }))) : null,
          h('div', null, h('button', { class: 'btn btn--sm', type: 'button', text: r.approved.length ? 'Not right? Edit the matched answer' : 'Not right? Save a better answer', on: { click: async () => {
            if (r.approved.length) { const all = await api('/admin/golden'); const g = all.find((x) => String(x.id) === String(r.approved[0].id)); if (g) return openGolden(g); }
            openGolden({ question, ideal_answer: r.answer, product: r.product });
          } } })));
      } catch (e) { out.replaceChildren(); fail(e); }
      finally { btn.disabled = false; btn.textContent = 'Ask DES'; }
    });
    return form;
  }

  /** Long card lists: render(slice) → node, then "Show more" (no page numbers). */
  function moreList(items, size, render) {
    const box = h('div'); let shown = size;
    const draw = () => box.replaceChildren(render(items.slice(0, shown)), items.length > shown ? h('div', { class: 'loadmore' }, h('span', { class: 'note', text: `${n(shown)} of ${n(items.length)}` }), h('button', { class: 'btn btn--sm', type: 'button', text: 'Show more', on: { click: () => { shown += size; draw(); } } })) : null);
    draw(); return box;
  }

  function tabAnswers(d, name, refresh) {
    const add = h('button', { class: 'btn btn--primary', type: 'button', text: '+ Add approved answer', on: { click: () => openGolden({ product: name }) } });
    if (!d.golden.length) return empty('No approved answers yet', `Add the answers you want DES to give about ${name === GENERAL ? 'general topics' : name}. For example: “Does ${name === GENERAL ? 'DynamIQ' : name} work for small companies?” with the exact reply. Start with questions visitors really ask (Visitor questions tab).`, add);
    return h('div', null, h('div', { class: 'panel-head' },
      h('span', { class: 'note', text: 'DES uses an answer when a visitor’s question matches its question or one of its variations.' }), add),
    moreList(d.golden, 10, (slice) => h('div', { class: 'cards' }, slice.map((g) => {
      const vars = String(g.variations || '').split('\n').filter(Boolean);
      const toggle = h('input', { type: 'checkbox', checked: g.active !== false, 'aria-label': 'Use in live chats' });
      toggle.addEventListener('change', async () => {
        const on = toggle.checked, put = (v) => api('/admin/golden/' + g.id, { method: 'PUT', body: { active: v } });
        try { await put(on); toast(on ? 'Answer is live' : 'Answer paused', false, { undo: async () => { await put(!on); refresh(); } }); refresh(); } catch (e) { toggle.checked = !on; fail(e); }
      });
      return h('article', { class: 'qa' + (g.active === false ? ' is-off' : '') },
        h('div', { class: 'qa__q' }, h('span', { text: g.question }), g.active === false ? badge('Paused') : null),
        vars.length ? h('div', { class: 'qa__vars', text: 'Also matches: ' + vars.join(' · ') }) : null,
        h('div', { class: 'qa__a', html: fmt(g.ideal_answer) }),
        h('div', { class: 'qa__foot' },
          h('label', { class: 'toggle' }, toggle, 'Live'),
          h('span', { text: g.use_count ? `Used ${n(g.use_count)}× · last ${ago(g.last_used_at)}` : 'Not used yet' }),
          h('span', { class: 'sp' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Edit', on: { click: () => openGolden(g) } }),
          menuBtn([{ label: 'Delete', danger: true, onClick: async () => { if (!await ask('DES stops using it straight away. To stop using it for now instead, switch “Live” off.', { title: 'Delete this approved answer?', ok: 'Delete' })) return; try { await api('/admin/golden/' + g.id, { method: 'DELETE' }); toast('Deleted'); refresh(); } catch (e) { fail(e); } } }])));
    }))));
  }

  function tabQuestions(d, name) {
    if (!d.questions.length) return empty('No questions yet', `Questions visitors ask about ${name === GENERAL ? 'general topics' : name} will appear here.`);
    // one card per question: what the visitor asked, DES's answer (opens on click), then the actions; never wider than the panel
    return moreList(d.questions, 15, (slice) => h('div', { class: 'cards' }, slice.map((q) => h('article', { class: 'qa' },
      h('div', { class: 'qa__q' }, h('span', { text: q.question }), h('span', { class: 'qa__when', text: ago(q.created_at) })),
      q.answer ? h('details', { class: 'qa__more' }, h('summary', null, h('span', { class: 'qa__label', text: 'DES answered' }), h('span', { class: 'qa__peek', text: q.answer.replace(/\s+/g, ' ') })),
        h('div', { class: 'qa__a', html: fmt(q.answer) })) : h('div', { class: 'qa__a muted', text: 'No answer recorded.' }),
      h('div', { class: 'qa__foot' },
        q.thumb === -1 ? ibadge('down', 'Disliked', 'badge--bad') : q.thumb === 1 ? ibadge('up', 'Liked', 'badge--good') : null,
        q.golden_ids ? badge('Used approved answer', 'badge--good') : null, q.blocked_reason ? badge(blockLabel(q.blocked_reason), 'badge--bad') : null,
        h('span', { class: 'sp' }),
        h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Write approved answer', on: { click: () => openGolden({ question: q.question, ideal_answer: q.answer || '', product: name, message_id: q.answer_id ? Number(q.answer_id) : null }) } }),
        h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Open chat', on: { click: () => openConversation(q.conversation_id) } }))))));
  }

  function tabNotes(d, name, refresh) {
    const ta = h('textarea', { class: 'input', rows: 10, maxlength: 6000, placeholder: name === GENERAL ? 'e.g. We are closed on 24–25 December. Demo slots are booked within 2 business days.' : `e.g. ${name} now supports … (launched Sept 2026).\nAlways mention the free business analysis.\nDo not promise integration with … yet.` });
    ta.value = d.notes || '';
    const save = h('button', { class: 'btn btn--primary', type: 'button', text: 'Save notes', on: { click: async () => { try { await api('/admin/products/' + encodeURIComponent(name) + '/notes', { method: 'PUT', body: { notes: ta.value } }); toast('Notes saved. DES uses them from the next message.'); refresh(); } catch (e) { fail(e); } } } });
    return h('div', null,
      h('div', { class: 'callout', style: { marginBottom: '12px' } }, name === GENERAL
        ? 'DES does not read General notes automatically, because they have no product to trigger them. Put company-wide facts in Settings → Knowledge instead, or add General approved answers.'
        : `DES reads these notes whenever a visitor asks about ${name}. Use them for facts the website doesn’t say yet, corrections, and how to talk about the product. They override older website text. Don’t put prices here: replies with prices are replaced by the standard “book a free analysis” message.`),
      h('label', { class: 'field' }, h('span', { text: 'Notes for DES' }), ta, h('small', { text: d.notes_updated_at ? 'Last saved ' + when(d.notes_updated_at) : 'Not saved yet' })),
      save);
  }

  function tabPages(d, name, refresh) {
    if (!d.docs.length) return empty('No website pages tagged', `No product page for ${name} was found in the website scrape. Add one in Website knowledge.`);
    return h('div', null, h('p', { class: 'note', style: { marginTop: 0 }, text: 'Pages DES reads for this product. Switch a page off to stop DES using it; re-read it after the website changes.' }),
      h('div', { class: 'rows' }, d.docs.map((doc) => kbRow(doc, refresh))));
  }

  /** A website page as a row: title, short address, type, passages, last read, "Used" switch, re-read. */
  function kbRow(doc, refresh, select) {
    const toggle = h('input', { type: 'checkbox', checked: doc.status === 'active', 'aria-label': 'Used by DES' });
    const reread = h('button', { class: 'btn btn--sm btn--ghost icon-btn', type: 'button', title: 'Read this page again', 'aria-label': 'Re-read ' + (doc.title || doc.url) }, icon('refresh'));
    const row = h('article', { class: 'rrow' + (doc.status !== 'active' ? ' is-off' : ''), 'data-id': doc.id },
      select ? h('input', { type: 'checkbox', class: 'rrow__check', 'aria-label': 'Select ' + (doc.title || doc.url), checked: select.has(doc.id), on: { change: (e) => select.toggle(doc.id, e.target.checked) } }) : null,
      h('div', { class: 'rrow__main' },
        h('a', { class: 'rrow__title', href: doc.url, target: '_blank', rel: 'noopener', text: doc.title || shortPath(doc.url) }),
        h('div', { class: 'rrow__meta' }, h('span', { class: 'mono', text: shortPath(doc.url) }), badge(doc.kind || 'page'), h('span', { text: plural(Number(doc.chunks) || 0, 'passage') }), h('span', { title: when(doc.updated_at), text: 'read ' + ago(doc.updated_at) }))),
      h('label', { class: 'toggle', title: 'Used by DES' }, toggle, h('span', { class: 'toggle__text', text: 'Used' })),
      reread);
    toggle.addEventListener('change', async () => {
      const on = toggle.checked, put = (v) => api('/admin/kb/' + doc.id, { method: 'PUT', body: { status: v ? 'active' : 'archived' } });
      try {
        await put(on); doc.status = on ? 'active' : 'archived'; row.classList.toggle('is-off', !on);
        toast(on ? 'Page is used again' : 'Page paused', false, { undo: async () => { await put(!on); doc.status = on ? 'archived' : 'active'; if (toggle.isConnected) { toggle.checked = !on; row.classList.toggle('is-off', on); } } });
      } catch (e) { toggle.checked = !on; fail(e); }
    });
    reread.addEventListener('click', async () => {
      reread.disabled = true; reread.classList.add('is-spin');
      try { const r = await api('/admin/ingest', { method: 'POST', body: { url: doc.url } }); toast(r.skipped ? 'No changes on that page' : 'Page re-read'); refresh?.(); } catch (e) { fail(e); } finally { reread.disabled = false; reread.classList.remove('is-spin'); }
    });
    return row;
  }

  // ---------------- approved-answer editor (side by side) ----------------
  function openGolden(init = {}) {
    const isEdit = !!init.id;
    const products = state.status.products;
    const product = h('select', { class: 'input' }, products.map((p) => h('option', { value: p, text: p === GENERAL ? 'General (all products)' : p, selected: (init.product || GENERAL) === p })));
    const question = h('input', { class: 'input', type: 'text', maxlength: 500, required: true, value: init.question || '', placeholder: 'e.g. Does IQ People compute 13th month pay?' });
    const variations = h('textarea', { class: 'input', rows: 4, maxlength: 4000, placeholder: 'Can your payroll compute the 13th month?\nKaya ba ng IQ People mag compute ng 13th month?' });
    variations.value = init.variations || '';
    const answer = h('textarea', { class: 'input', rows: 9, maxlength: 3000, required: true, placeholder: 'Write the answer the way DES should say it. Short paragraphs, **bold**, - bullet lists and dynamiqes.com links work.' });
    answer.value = init.ideal_answer || '';
    const active = h('input', { type: 'checkbox', checked: init.active !== false });
    const preview = h('div', { class: 'bubble preview' }); const warn = h('div', { class: 'note', style: { color: 'var(--bad)', marginTop: '6px' }, hidden: true, text: 'This answer mentions a price. DES replaces any reply with prices by the standard “book a free analysis” message, so visitors won’t see it.' });
    const sync = () => { preview.innerHTML = answer.value.trim() ? fmt(answer.value) : '<span class="muted">Preview appears here.</span>'; warn.hidden = !priceLike(answer.value); };
    answer.addEventListener('input', sync); sync();
    const save = h('button', { class: 'btn btn--primary', type: 'submit', text: isEdit ? 'Save changes' : 'Save answer' });
    const form = h('form', { class: 'modal__card modal__card--wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Approved answer' },
      h('div', { class: 'modal__head' }, h('div', null, h('h2', { text: isEdit ? 'Edit approved answer' : 'New approved answer' }), h('p', { text: 'When a visitor asks something similar, DES bases its reply on this answer and keeps its facts and links.' })),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: closeLayer } }, icon('x'))),
      h('div', { class: 'modal__body golden-grid' },
        h('div', { class: 'golden-grid__q' },
          h('div', { class: 'golden-grid__label', text: 'The visitor asks' }),
          h('label', { class: 'field' }, h('span', { text: 'Visitor question' }), question),
          h('label', { class: 'field' }, h('span', { text: 'Other ways visitors ask this' }), variations, h('small', { text: 'Optional, one per line. Add rewordings and Filipino or Taglish versions so DES recognises them.' })),
          h('label', { class: 'field' }, h('span', { text: 'Product' }), product, h('small', { text: 'DES only uses this answer when the visitor is asking about this product. General answers work for any product.' }))),
        h('div', { class: 'golden-grid__a' },
          h('div', { class: 'golden-grid__label', text: 'DES answers' }),
          h('label', { class: 'field' }, h('span', { text: 'Approved answer' }), answer),
          h('div', { class: 'field' }, h('span', { text: 'How visitors will see it' }), preview, warn),
          h('label', { class: 'toggle' }, active, 'Use this answer in live chats'))),
      h('div', { class: 'modal__foot' },
        isEdit ? h('button', { class: 'btn btn--danger btn--ghost', type: 'button', text: 'Delete', on: { click: async () => { if (!await ask('DES stops using it straight away. To stop using it for now instead, switch “Live” off.', { title: 'Delete this approved answer?', ok: 'Delete' })) return; try { await api('/admin/golden/' + init.id, { method: 'DELETE' }); toast('Deleted'); closeLayer(); route(); } catch (e) { fail(e); } } } }) : null,
        h('span', { class: 'sp' }),
        h('button', { class: 'btn', type: 'button', text: 'Cancel', on: { click: closeLayer } }), save));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = { product: product.value, question: question.value.trim(), variations: variations.value, ideal_answer: answer.value.trim(), active: active.checked };
      if (!body.question || !body.ideal_answer) return toast('Fill in the question and the answer', true);
      if (!isEdit && init.message_id) body.message_id = init.message_id;
      save.disabled = true;
      try {
        await api(isEdit ? '/admin/golden/' + init.id : '/admin/golden', { method: isEdit ? 'PUT' : 'POST', body });
        toast(isEdit ? 'Answer updated. DES uses it from the next message.' : 'Answer saved. DES uses it from the next message.');
        closeLayer(); refreshReviewCount();
        if (location.hash.startsWith('#/finetune')) location.hash === '#/finetune/' + encodeURIComponent(body.product) ? route() : (location.hash = '#/finetune/' + encodeURIComponent(body.product));
        else if (location.hash.startsWith('#/review')) route();
      } catch (e) { fail(e); save.disabled = false; }
    });
    openLayer(h('div', { class: 'modal' }, form), true);
    (init.question ? answer : question).focus();
  }

  // =====================================================================================
  // Needs review
  // =====================================================================================
  let reviewKeys = null;
  async function pageReview() {
    const moved = navToken();
    loading();
    let q, s; try { [q, s] = await Promise.all([api('/admin/review-queue'), api('/admin/feedback/summary')]); } catch (e) { return moved() ? undefined : fail(e); }
    if (moved()) return;
    q.forEach((r) => { r.product = r.product || guessProduct(r.question); });
    const resolved = (s.resolved_yes || 0) + (s.resolved_partly || 0) + (s.resolved_no || 0);
    const reasons = [...new Set(q.flatMap((r) => r.reasons || []))].sort().map((x) => [x, x]);
    const products = [...new Set(q.map((r) => r.product))].sort().map((x) => [x, x === GENERAL ? 'General' : x]);
    const listBox = h('div');
    let rows = [], focusIdx = -1;
    const bar = filterBar({
      id: 'review', search: 'Search the question or the reply…',
      filters: [{ key: 'reason', label: 'Why they disliked it', options: reasons, multi: true }, { key: 'product', label: 'Product', options: products, multi: true }],
      sort: { options: [['newest', 'Newest first'], ['oldest', 'Oldest first']], def: 'newest' },
      onChange: () => draw(),
    });
    const write = (r) => openGolden({ question: r.question || '', ideal_answer: r.answer, product: r.product, message_id: Number(r.message_id) });
    const card = (r) => {
      const i = rows.indexOf(r);
      return h('article', { class: 'qa review-card', tabindex: '0', on: { focus: () => { focusIdx = i; } } },
        h('div', { class: 'review-card__part' }, h('span', { class: 'qa__label', text: 'Visitor asked' }), h('div', { class: 'qa__q', text: r.question || '(question not found)' })),
        h('div', { class: 'review-card__part review-card__part--reply' }, h('span', { class: 'qa__label', text: 'DES replied' }), h('div', { class: 'qa__a', html: fmt(r.answer) })),
        h('div', { class: 'qa__foot' },
          (r.reasons?.length ? r.reasons : ['Disliked']).map((x) => ibadge('down', x, 'badge--bad')), productChip(r.product),
          r.created_at ? h('span', { title: when(r.created_at), text: ago(r.created_at) }) : null,
          h('span', { class: 'sp' }),
          h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Write the right answer', title: 'Shortcut: E', on: { click: () => write(r) } }),
          h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Open chat', title: 'Shortcut: O', on: { click: () => openConversation(r.conversation_id) } })));
    };
    function draw() {
      const st = bar.state, t = st.q.toLowerCase();
      rows = q.filter((r) => (!t || `${r.question} ${r.answer}`.toLowerCase().includes(t))
        && (!st.reason.length || (r.reasons || []).some((x) => st.reason.includes(x))) && (!st.product.length || st.product.includes(r.product)));
      if (st.sort === 'oldest') rows.reverse();
      focusIdx = -1;
      bar.setResult(`${n(rows.length)} of ${n(q.length)} to review`);
      listBox.replaceChildren(rows.length ? moreList(rows, 10, (slice) => h('div', { class: 'cards' }, slice.map(card)))
        : q.length ? zeroState(bar, 'Nothing matches') : empty('Nothing to review', 'When a visitor gives an answer a thumbs down, it shows up here.'));
    }
    draw();
    // keyboard: J / K move between cards, E writes the answer, O opens the chat
    if (reviewKeys) document.removeEventListener('keydown', reviewKeys);
    reviewKeys = (e) => {
      if (currentPage() !== 'review' || layer.childElementCount || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const all = [...listBox.querySelectorAll('.review-card')]; if (!all.length) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || k === 'k') { e.preventDefault(); focusIdx = Math.max(0, Math.min(all.length - 1, focusIdx + (k === 'j' ? 1 : -1))); all[focusIdx].focus(); all[focusIdx].scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }
      else if ((k === 'e' || k === 'o') && focusIdx >= 0 && rows[focusIdx]) { e.preventDefault(); if (k === 'e') write(rows[focusIdx]); else openConversation(rows[focusIdx].conversation_id); }
    };
    document.addEventListener('keydown', reviewKeys);
    main.replaceChildren(
      top('Needs review', 'Answers visitors disliked. Write the answer DES should have given.'),
      h('div', { class: 'grid grid--kpi', style: { marginBottom: '16px' } },
        statCard({ label: 'Waiting for review', value: n(q.length) }),
        statCard({ label: 'Average rating', value: s.avg_rating ? `${Number(s.avg_rating).toFixed(1)} / 5` : '—', sub: `${n(s.surveys)} surveys · 30 days` }),
        statCard({ label: 'Found what they needed', value: resolved ? `${Math.round(((s.resolved_yes || 0) / resolved) * 100)}%` : '—', sub: resolved ? `${n(s.resolved_yes)} yes · ${n(s.resolved_partly)} partly · ${n(s.resolved_no)} no` : 'no answers yet' }),
        statCard({ label: 'Thumbs down', value: n(s.thumbs_down), sub: `${n(s.thumbs_up)} thumbs up · 30 days` })),
      s.reasons?.length ? h('details', { class: 'card card--fold', style: { marginBottom: '16px' } }, h('summary', { class: 'card__head' }, h('h2', { text: 'Why visitors disliked answers' })), h('div', { class: 'card__body' }, hbars(s.reasons.map((r) => ({ label: r.reason, n: r.n }))))) : null,
      h('section', { class: 'card card--list' }, h('div', { class: 'card__head card__head--bar' }, bar.el),
        h('div', { class: 'card__body' }, h('p', { class: 'note kbd-hint' }, 'Shortcuts: ', h('kbd', { text: 'J' }), ' / ', h('kbd', { text: 'K' }), ' next / previous · ', h('kbd', { text: 'E' }), ' write the answer · ', h('kbd', { text: 'O' }), ' open the chat'), listBox)));
  }
  function guessProduct(text) {
    const t = String(text || '').toLowerCase();
    return state.status.products.find((p) => p !== GENERAL && t.includes(p.toLowerCase())) || GENERAL;
  }

  // =====================================================================================
  // Website knowledge
  // =====================================================================================
  async function pageKb() {
    const moved = navToken();
    loading();
    let kb; try { kb = await api('/admin/kb'); } catch (e) { return moved() ? undefined : fail(e); }
    if (moved()) return;
    const kinds = [...new Set(kb.docs.map((d) => d.kind || 'page'))].sort();
    const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
    const sel = new Set();
    const bulkBar = h('div', { class: 'bulkbar', hidden: true, role: 'region', 'aria-label': 'Selected pages' });
    const listBox = h('div');
    const select = { has: (id) => sel.has(id), toggle: (id, on) => { if (on) sel.add(id); else sel.delete(id); drawBulk(); } };
    let rows = [];
    const bar = filterBar({
      id: 'kb', search: 'Search page title or address…',
      seg: { key: 'kind', label: 'Page type', options: [['', 'All'], ...kinds.map((k) => [k, cap(k)])], def: '' },
      filters: [{ key: 'used', label: 'Status', options: [['active', 'Used by DES'], ['archived', 'Paused']] },
        { key: 'fresh', label: 'Last read', options: [['week', 'This week'], ['old', 'More than 30 days ago']] }],
      sort: { options: [['recent', 'Recently read'], ['title', 'Title A–Z'], ['passages', 'Most passages'], ['oldest', 'Read longest ago']], def: 'recent' },
      onChange: () => draw(),
    });
    function draw() {
      const st = bar.state, t = st.q.toLowerCase(), now = Date.now();
      const counts = { all: 0 }; kinds.forEach((k) => { counts[k] = 0; });
      rows = kb.docs.filter((d) => {
        const age = (now - new Date(d.updated_at).getTime()) / 864e5;
        const ok = (!t || (d.title || '').toLowerCase().includes(t) || d.url.toLowerCase().includes(t)) && (!st.used || d.status === st.used)
          && (!st.fresh || (st.fresh === 'week' ? age <= 7 : age > 30));
        if (ok) { counts.all++; counts[d.kind || 'page']++; }
        return ok && (!st.kind || (d.kind || 'page') === st.kind);
      });
      bar.setCounts(counts);
      const by = { title: (a, b) => (a.title || a.url).localeCompare(b.title || b.url), passages: (a, b) => (b.chunks || 0) - (a.chunks || 0), oldest: (a, b) => new Date(a.updated_at) - new Date(b.updated_at), recent: (a, b) => new Date(b.updated_at) - new Date(a.updated_at) };
      rows.sort(by[st.sort] || by.recent);
      bar.setResult(`${n(rows.length)} of ${n(kb.docs.length)} pages`);
      listBox.replaceChildren(rows.length ? moreList(rows, 25, (slice) => h('div', { class: 'rows' }, slice.map((d) => kbRow(d, null, select)))) : zeroState(bar, 'No pages match'));
      drawBulk();
    }
    const runBulk = async (label, fn) => {
      const ids = [...sel]; let done = 0, bad = 0;
      toast(`${label} ${plural(ids.length, 'page')}…`);
      for (const id of ids) { try { await fn(kb.docs.find((d) => d.id === id)); done++; } catch { bad++; } }
      toast(bad ? `${done} done, ${bad} failed` : `Done: ${plural(done, 'page')}`, !!bad);
      sel.clear(); pageKb();
    };
    function drawBulk() {
      bulkBar.hidden = !sel.size;
      if (!sel.size) return;
      const visibleIds = rows.map((d) => d.id);
      bulkBar.replaceChildren(
        h('b', { text: `${n(sel.size)} selected` }),
        h('button', { class: 'link-btn', type: 'button', text: `Select all ${n(visibleIds.length)} shown`, on: { click: () => { visibleIds.forEach((i) => sel.add(i)); draw(); } } }),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Pause', on: { click: () => runBulk('Pausing', (d) => api('/admin/kb/' + d.id, { method: 'PUT', body: { status: 'archived' } })) } }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Use again', on: { click: () => runBulk('Resuming', (d) => api('/admin/kb/' + d.id, { method: 'PUT', body: { status: 'active' } })) } }),
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Re-read', on: { click: () => runBulk('Re-reading', (d) => api('/admin/ingest', { method: 'POST', body: { url: d.url } })) } }),
        h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Clear', on: { click: () => { sel.clear(); draw(); } } }));
    }
    const addPage = () => {
      const url = h('input', { class: 'input', type: 'url', required: true, placeholder: 'https://dynamiqes.com/…' });
      dialog('Add or re-read a page', 'DES reads the page and uses it from the next message. Only dynamiqes.com addresses.', [h('label', { class: 'field' }, h('span', { text: 'Page address' }), url)], 'Read page', async () => {
        try { const r = await api('/admin/ingest', { method: 'POST', body: { url: url.value.trim() } }); if (r.error) { toast('Could not read: ' + r.error, true); return false; } toast('Page read'); pageKb(); return true; } catch (err) { fail(err); return false; }
      }, { width: 480 });
    };
    const sweep = async () => { if (!await ask('Every page in the website sitemap is checked in the background; only pages that changed are read again. Uses a little AI credit.', { title: 'Re-read the whole website?', ok: 'Start', danger: false })) return; try { await api('/admin/ingest', { method: 'POST', body: {} }); toast('Started. Changed pages update over the next few minutes.'); } catch (e) { fail(e); } };
    // reading activity: day-grouped timeline, failures easy to find
    let failsOnly = false;
    const logBox = h('div');
    const drawLog = () => {
      const logs = kb.log.filter((l) => !failsOnly || !l.ok).slice(0, 40);
      logBox.replaceChildren(logs.length ? timeline(logs, (l) => l.created_at, (l) => h('li', { class: 'tl__item' + (l.ok ? '' : ' is-high') },
        h('span', { class: 'tl__icon' }, icon(!l.ok ? 'alert' : /archiv/i.test(l.action || '') ? 'archive' : /creat|new|add/i.test(l.action || '') ? 'plus' : 'refresh')),
        h('div', { class: 'tl__main' }, h('div', { class: 'tl__text' }, `${cap(l.action || 'read')} `, h('span', { class: 'mono', text: shortPath(l.url) })),
          h('div', { class: 'tl__meta' }, h('time', { text: timeF.format(new Date(l.created_at)) }), l.ok ? null : badge('Failed', 'badge--bad'), l.detail ? h('span', { text: l.detail }) : null)))) : empty(failsOnly ? 'No failures' : 'No reading activity yet', null));
    };
    drawLog();
    const active = kb.docs.filter((d) => d.status === 'active').length;
    const fails = kb.log.filter((l) => !l.ok).length;
    main.replaceChildren(
      top('Website knowledge', `${n(active)} of ${n(kb.docs.length)} dynamiqes.com pages are used by DES. Pause outdated pages; re-read pages after editing them on the website.`,
        h('button', { class: 'btn', type: 'button', on: { click: sweep } }, icon('refresh'), 'Re-read whole website'),
        h('button', { class: 'btn btn--primary', type: 'button', text: '+ Add page', on: { click: addPage } })),
      h('section', { class: 'card card--list' }, h('div', { class: 'card__head card__head--bar' }, bar.el), bulkBar, h('div', { class: 'card__body' }, listBox)),
      kb.log.length ? h('details', { class: 'card card--fold', style: { marginTop: '16px' }, open: fails > 0 },
        h('summary', { class: 'card__head' }, h('div', null, h('h2', { text: 'Recent reading activity' }), h('p', { text: fails ? `${fails} failed of the last ${kb.log.length}` : `Last ${kb.log.length} reads, no failures` }))),
        h('div', { class: 'card__body' }, h('label', { class: 'check', style: { marginBottom: '10px' } }, h('input', { type: 'checkbox', on: { change: (e) => { failsOnly = e.target.checked; drawLog(); } } }), ' Failures only'), logBox)) : null,
    );
    draw();
  }

  // =====================================================================================
  // Settings: sections with a side menu
  // =====================================================================================
  async function pageSettings(tabArg) {
    const moved = navToken();
    loading();
    const get = (perm, path, emptyV) => (can(perm) ? api(path) : Promise.resolve(emptyV));
    let facts, gloss, prompt, bans, sites, settings, shares, budget = null;
    try {
      [facts, gloss, prompt, bans, sites, settings, shares] = await Promise.all([get('facts.manage', '/admin/facts', []), get('facts.manage', '/admin/glossary', []), get('prompt.manage', '/admin/prompt', {}),
        get('bans.manage', '/admin/bans', { active: 0, by_kind: {}, bans: [] }), get('settings.manage', '/admin/sites', { base: '', fixed: [], sites: [] }), get('settings.manage', '/admin/settings', []), get('share.create', '/admin/shares', [])]);
      budget = (await fetch('/api/health').then((r) => r.json()).catch(() => ({}))).budget || null;
    } catch (e) { return moved() ? undefined : fail(e); }
    if (moved()) return;
    const s = state.status;
    const TABS = [['ai', 'AI & budget', true], ['widget', 'Website & widget', can('settings.manage')], ['knowledge', 'Knowledge', can('facts.manage')], ['shares', 'Share links', can('share.create')],
      ['safety', 'Safety', can('bans.manage')], ['instructions', 'Instructions', can('prompt.manage')]].filter(([, , ok]) => ok);
    let tab = TABS.some(([k]) => k === tabArg) ? tabArg : 'ai';
    const panel = h('div', { class: 'settings__panel', role: 'tabpanel' });
    const reload = () => pageSettings(tab);

    const sections = {
      ai: () => {
        const unsaved = h('div', { class: 'savebar', hidden: true, role: 'region', 'aria-label': 'Unsaved changes' });
        const inputs = settings.map((x) => {
          const i = h('input', { class: 'input input--num', type: 'number', min: 0, step: '0.5', value: x.value ?? '', placeholder: String(x.effective), 'aria-label': x.label });
          i.dataset.key = x.key; i.dataset.initial = x.value ?? ''; return { x, i };
        });
        const syncBar = () => { unsaved.hidden = !inputs.some(({ i }) => i.value !== i.dataset.initial); };
        inputs.forEach(({ i }) => i.addEventListener('input', syncBar));
        const saveAll = async () => {
          const body = Object.fromEntries(inputs.map(({ x, i }) => [x.key, i.value === '' ? null : Number(i.value)]));
          try { await api('/admin/settings', { method: 'PUT', body }); toast('Saved'); state.status = await api('/admin/status'); renderStatus(); reload(); } catch (e) { fail(e); }
        };
        unsaved.append(h('span', { text: 'Unsaved changes' }), h('span', { class: 'sp' }),
          h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Discard', on: { click: () => { inputs.forEach(({ i }) => { i.value = i.dataset.initial; }); syncBar(); } } }),
          h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Save', on: { click: saveAll } }));
        const pct = budget?.budget ? (budget.spent / budget.budget) * 100 : 0;
        return [
          can('settings.manage') ? h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'AI budget and limits' }), h('p', { text: 'Changes apply straight away, no restart. Leave a box empty to use the server default.' }))),
            h('div', { class: 'card__body setting-list' }, inputs.map(({ x, i }) => h('div', { class: 'setting' },
              h('div', { class: 'setting__text' }, h('b', { text: x.label }), h('p', { class: 'note', text: x.help }),
                h('p', { class: 'note', text: `Now: ${x.effective}${x.updated_by ? ` · changed by ${x.updated_by} ${when(x.updated_at)}` : ' · server default'}` }),
                x.key === 'daily_budget_usd' && budget ? h('div', { class: 'budget-use' }, h('div', { class: 'meter' + (pct >= 100 ? ' is-full' : pct >= 80 ? ' is-warn' : '') }, h('div', { class: 'meter__fill', style: { width: Math.min(100, pct) + '%' } })),
                  h('span', { class: 'note', text: `Today: ${usd(budget.spent)} of ${usd(budget.budget)} (${Math.round(pct)}%). At 100% DES stops calling the AI and hands every chat to Sales.` })) : null),
              h('div', { class: 'setting__control' }, i)))), unsaved) : null,
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('h2', { text: 'Connection' })), h('div', { class: 'card__body' }, h('div', { class: 'facts' },
            [['Mode', s.mock ? 'Mock (no AI key; canned answers)' : 'Live AI through IQGateway'], ['AI model', s.model], ['Gateway', s.gateway],
              ['Website search', s.embeddings === 'voyage' ? 'Voyage AI (meaning-based)' : 'Keyword-based (offline). Voyage AI gives better results.'],
              ['Answer matching', `An approved answer is used when the match score is at least ${Math.round(s.golden_min_score * 100)}%.`], ['Daily AI budget', usd(s.daily_budget_usd)]]
              .map(([k, v]) => h('div', { class: 'fact' }, h('span', { class: 'fact__k', text: k }), h('span', { class: 'fact__v', text: v })))))),
        ];
      },
      widget: () => {
        const embedCode = `<script src="${sites.base}/widget/embed.js" data-api="${sites.base}/api" defer></script>`;
        const codeTa = h('textarea', { class: 'input mono', rows: 2, readOnly: true, 'aria-label': 'Embed code', on: { focus: (e) => e.target.select() } }); codeTa.value = embedCode;
        const siteRow = (origin, { note, added_at, fixed } = {}) => h('article', { class: 'rrow' },
          h('span', { class: 'rrow__icon' }, icon('globe')),
          h('div', { class: 'rrow__main' }, h('b', { class: 'mono', text: origin }), h('div', { class: 'rrow__meta' }, fixed ? badge('Server settings') : note ? h('span', { text: note }) : null, fixed ? null : h('span', { text: 'added ' + ago(added_at) }))),
          fixed ? null : h('button', { class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Remove', on: { click: async () => {
            if (!await ask(`The chat disappears from ${origin} straight away.`, { title: 'Remove this website?', ok: 'Remove' })) return;
            try { await api('/admin/sites?origin=' + encodeURIComponent(origin), { method: 'DELETE' }); toast('Removed'); reload(); } catch (e) { fail(e); }
          } } }));
        const addSite = () => {
          const site = h('input', { class: 'input mono', required: true, placeholder: 'https://www.example.com' });
          const note = h('input', { class: 'input', placeholder: 'e.g. client test site' });
          dialog('Allow the chat on a website', 'Add the address exactly as visitors see it. www and non-www are different sites; one entry covers every page.', [
            h('label', { class: 'field' }, h('span', { text: 'Website address' }), site), h('label', { class: 'field' }, h('span', { text: 'Note (optional)' }), note)], 'Allow website', async () => {
            try { const r = await api('/admin/sites', { method: 'POST', body: { origin: site.value.trim(), note: note.value.trim() } }); toast(`Chat allowed on ${r.origin}`); reload(); return true; } catch (e) { fail(e); return false; }
          }, { width: 480 });
        };
        return [
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Embed code' }), h('p', { text: 'Paste this into an allowed website (WordPress: the site footer) and the chat appears bottom-right.' })),
            h('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Copy code', on: { click: () => copyText(embedCode, 'Embed code copied') } })), h('div', { class: 'card__body' }, codeTa)),
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Allowed websites' }), h('p', { text: 'The chat only shows on these. On any other website it stays hidden.' })),
            h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add website', on: { click: addSite } })),
            h('div', { class: 'card__body' }, h('div', { class: 'rows' }, sites.fixed.map((o) => siteRow(o, { fixed: true })), sites.sites.map((x) => siteRow(x.origin, x))))),
        ];
      },
      knowledge: () => {
        const editRow = ({ k, v, isNew, keyLabel, valLabel, keyPh, valPh, mono, onSave, onDelete }) => {
          const key = h('input', { class: 'input' + (mono ? ' mono' : ''), value: k, placeholder: keyPh, readOnly: !isNew, 'aria-label': keyLabel });
          const val = h('input', { class: 'input', value: v, placeholder: valPh, 'aria-label': valLabel });
          const saveBtn = h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Save', hidden: !isNew });
          val.addEventListener('input', () => { saveBtn.hidden = !isNew && val.value === v; });
          saveBtn.addEventListener('click', async () => { if (!key.value.trim() || !val.value.trim()) return toast('Fill in both boxes', true); try { await onSave(key.value.trim(), val.value.trim()); toast('Saved'); if (isNew) reload(); else { v = val.value; saveBtn.hidden = true; } } catch (e) { fail(e); } });
          const row = h('div', { class: 'erow' + (isNew ? ' is-new' : '') }, h('div', { class: 'erow__key' }, key), h('div', { class: 'erow__val' }, val), h('div', { class: 'erow__act' }, saveBtn,
            isNew ? h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Cancel', on: { click: () => row.remove() } }) : menuBtn([{ label: 'Delete', danger: true, onClick: async () => { if (await onDelete()) row.remove(); } }])));
          return row;
        };
        const factRow = (f, isNew) => editRow({ k: f?.key || '', v: f?.value || '', isNew, keyLabel: 'Fact name', valLabel: 'Fact value', keyPh: 'key_name', valPh: 'Value', mono: true,
          onSave: (k, v) => api('/admin/facts/' + encodeURIComponent(k.replace(/\s+/g, '_').toLowerCase()), { method: 'PUT', body: { value: v } }),
          onDelete: async () => { if (!await ask('DES no longer knows this fact from the next message.', { title: `Delete the fact “${f.key}”?`, ok: 'Delete' })) return false; try { await api('/admin/facts/' + encodeURIComponent(f.key), { method: 'DELETE' }); toast('Deleted'); return true; } catch (e) { fail(e); return false; } } });
        const glossRow = (g, isNew) => editRow({ k: g?.term || '', v: g?.definition || '', isNew, keyLabel: 'Term', valLabel: 'Meaning', keyPh: 'Term', valPh: 'Plain-language meaning',
          onSave: (k, v) => api('/admin/glossary/' + encodeURIComponent(k), { method: 'PUT', body: { definition: v } }),
          onDelete: async () => { if (!await ask('DES no longer gets this meaning from the next message.', { title: `Delete “${g.term}”?`, ok: 'Delete' })) return false; try { await api('/admin/glossary/' + encodeURIComponent(g.term), { method: 'DELETE' }); toast('Deleted'); return true; } catch (e) { fail(e); return false; } } });
        const factBox = h('div', { class: 'erows' }, facts.map((f) => factRow(f)));
        const glossBox = h('div', { class: 'erows' }, gloss.map((g) => glossRow(g)));
        const addTo = (box, row) => { box.append(row); row.querySelector('input').focus(); };
        return [
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Company facts' }), h('p', { text: 'Sent to DES with every message. Keep them short and exact.' })),
            h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add fact', on: { click: () => addTo(factBox, factRow(null, true)) } })),
            h('div', { class: 'card__body' }, facts.length ? null : h('p', { class: 'muted', text: 'No facts yet. Example: office_hours → Monday to Friday, 8 AM to 5 PM.' }), factBox)),
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Glossary' }), h('p', { text: 'When a visitor uses one of these terms, DES gets the plain-language meaning.' })),
            h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add term', on: { click: () => addTo(glossBox, glossRow(null, true)) } })),
            h('div', { class: 'card__body' }, gloss.length ? null : h('p', { class: 'muted', text: 'No terms yet. Example: BIR CAS → the BIR’s approval for computerised accounting systems.' }), glossBox)),
        ];
      },
      shares: () => {
        let only = 'all';
        const box = h('div', { class: 'cards cards--grid' });
        const chips = h('div', { class: 'qchips qchips--sm', role: 'group', 'aria-label': 'Show' });
        const soon = (l) => new Date(l.expires_at) - Date.now() < 864e5;
        const draw = () => {
          const list = shares.filter((l) => only === 'all' || soon(l));
          chips.replaceChildren(...[['all', 'All active', shares.length], ['soon', 'Expiring within 24 h', shares.filter(soon).length]].map(([v, l, c]) => h('button', { type: 'button', class: 'qchip' + (only === v ? ' is-on' : ''), 'aria-pressed': String(only === v), on: { click: () => { only = v; draw(); } } }, l, h('span', { class: 'qchip__n', text: n(c) }))));
          box.replaceChildren(...(list.length ? list.map((l) => h('article', { class: 'scard' + (soon(l) ? ' is-soon' : '') },
            h('div', { class: 'scard__top' }, avatar(l.name), h('div', null, h('b', { text: l.name }), h('div', { class: 'note', text: `by ${l.created_by_email || '—'} · ${ago(l.created_at)}` }))),
            h('div', { class: 'scard__facts' }, h('span', { title: when(l.expires_at) }, icon('clock'), 'Expires ', h('b', { text: untilText(l.expires_at) })), h('span', null, icon('eye'), 'Opened ', h('b', { text: `${l.view_count}×` })), l.last_viewed_at ? h('span', { class: 'note', text: 'last ' + ago(l.last_viewed_at) }) : null),
            h('div', { class: 'scard__act' }, h('button', { class: 'btn btn--sm', type: 'button', text: 'Open conversation', on: { click: () => openConversation(l.conversation_id) } }),
              h('button', { class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Revoke', on: { click: async () => { if (!await ask('Anyone who has the link can no longer open the conversation.', { title: 'Revoke this share link?', ok: 'Revoke link' })) return; try { await api('/admin/shares/' + l.id, { method: 'DELETE' }); toast('Link revoked'); reload(); } catch (e) { fail(e); } } } }))))
            : [empty(only === 'all' ? 'No active share links' : 'Nothing expires within 24 hours', 'Create one from a conversation (Create share link).')]));
        };
        draw();
        return [h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Active share links' }), h('p', { text: 'Conversations shared as a read-only page without sign-in. Copy the link when you create it; revoke here.' })), chips), h('div', { class: 'card__body' }, box))];
      },
      safety: () => [h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Bans after ended chats' }),
          h('p', { text: 'When DES ends a chat for repeated off-topic or abusive messages, that device, contact and visitor are paused for 24 h and the connection for 1 h.' })),
        h('button', { class: 'btn btn--danger', type: 'button', disabled: !bans.active, text: 'Lift all bans', on: { click: async () => {
          if (!await ask('Banned visitors can start a new chat straight away.', { title: 'Lift every active ban?', ok: 'Lift all bans' })) return;
          try { const r = await api('/admin/bans', { method: 'DELETE' }); toast(`Lifted (${r.lifted} ban records removed)`); reload(); } catch (e) { fail(e); }
        } } })),
        h('div', { class: 'card__body' }, bans.active
          ? h('div', { class: 'stat-chips' }, h('span', { class: 'stat-chip is-bad' }, h('b', { text: n(bans.active) }), ' active bans'),
            Object.entries(bans.by_kind).map(([k, v]) => h('span', { class: 'stat-chip' }, h('b', { text: n(v) }), ' ' + (({ ip: 'connection', device: 'device', visitor: 'visitor', contact: 'contact' })[k] || k))),
            h('span', { class: 'note', text: `from ${plural(bans.ended_chats || 0, 'ended chat')} · latest ends ${when(bans.bans.map((b) => b.until).sort().at(-1))}` }))
          : empty('No active bans', 'Visitors DES ends a chat with appear here for 24 hours.')))],
      instructions: () => {
        const promptTa = h('textarea', { class: 'input mono', rows: 22, 'aria-label': 'Bot instructions' }); promptTa.value = prompt.text || '';
        return [h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Bot instructions (advanced)' }), h('p', { text: `Version ${prompt.version || 'from file'} · persona, rules and tone. Most changes belong in approved answers or product notes instead.` }))),
          h('div', { class: 'card__body' },
            h('div', { class: 'callout', style: { marginBottom: '12px' } }, 'Saving creates a new version and DES uses it immediately. A broken edit can make every answer worse, so test a few questions in Fine-tune answers afterwards.'),
            promptTa,
            h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn btn--primary', type: 'button', text: 'Save as new version', on: { click: async () => {
              if (!promptTa.value.trim()) return toast('The instructions can’t be empty', true);
              if (!await ask('DES uses the new instructions from the next message. Test a few questions in Fine-tune answers afterwards.', { title: 'Replace the bot instructions?', ok: 'Save new version' })) return;
              try { await api('/admin/prompt', { method: 'POST', body: { version: 'dashboard ' + new Date().toISOString().slice(0, 16).replace('T', ' '), text: promptTa.value } }); toast('New instructions are live'); reload(); } catch (e) { fail(e); }
            } } }))))];
      },
    };
    const show = (key) => { tab = key; history.replaceState(null, '', '#/settings/' + key); panel.replaceChildren(h('div', { class: 'stack' }, sections[key]())); };
    const subnav = h('nav', { class: 'subnav', 'aria-label': 'Settings sections' }, TABS.map(([k, l]) => h('button', { type: 'button', 'data-tab': k, class: k === tab ? 'is-on' : null, 'aria-current': k === tab ? 'true' : null, text: l,
      on: { click: (e) => { subnav.querySelectorAll('button').forEach((b) => { const on = b === e.currentTarget; b.classList.toggle('is-on', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }); show(k); } } })));
    main.replaceChildren(
      top('Settings', null),
      h('div', { class: 'settings' }, subnav, panel));
    show(tab);
  }

  // ---------------- share links ----------------
  function openShare(conversationId, name, after) {
    const ttl = h('select', { class: 'input', 'aria-label': 'Link works for' }, [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']].map(([v, t]) => h('option', { value: v, text: t })));
    ttl.value = '7d';
    const out = h('div');
    const create = h('button', { class: 'btn btn--primary', type: 'submit', text: 'Create link' });
    const form = h('form', { class: 'modal__card', style: { width: 'min(520px, 100%)' }, on: { submit: async (e) => {
      e.preventDefault(); create.disabled = true; create.textContent = 'Creating…';
      try {
        const r = await api(`/admin/conversations/${conversationId}/share`, { method: 'POST', body: { ttl: ttl.value } });
        // Use the address this dashboard is open at, so the link follows whatever tunnel/domain is serving it now.
        let link = r.url;
        try { const u = new URL(r.url, location.origin); link = location.origin + u.pathname + u.search; } catch { /* keep server URL */ }
        const url = h('input', { class: 'input mono', readOnly: true, value: link, 'aria-label': 'Share link', on: { focus: (ev) => ev.target.select() } });
        out.replaceChildren(h('div', { class: 'callout', style: { marginTop: '12px' } }, 'Copy it now: for safety it is shown only once. It works until ' + when(r.expires_at) + '.'), h('div', { class: 'pw-row', style: { marginTop: '8px' } }, url,
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Copy link', on: { click: () => copyText(link, 'Link copied') } })));
        create.hidden = true; after?.();
      } catch (err) { fail(err); create.disabled = false; create.textContent = 'Create link'; }
    } } },
      h('div', { class: 'modal__head' }, h('div', null, h('h2', { text: 'Share this conversation' }), h('p', { text: `Anyone with the link can read ${name}'s details and the whole chat without signing in. You can revoke it any time.` }))),
      h('div', { class: 'modal__body' }, h('label', { class: 'field' }, h('span', { text: 'Link works for' }), ttl), out),
      h('div', { class: 'modal__foot' }, h('button', { class: 'btn', type: 'button', text: 'Close' }), create));
    // the drawer stays underneath: show the dialog on top of it
    const holder = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Share this conversation', style: { zIndex: 60 } }, form);
    layer.append(holder); ttl.focus();
    form.querySelector('.modal__foot .btn').onclick = () => holder.remove();
  }

  // =====================================================================================
  // Users
  // =====================================================================================
  const roleSelect = (value, on, full = false) => { const s = h('select', { class: 'input', 'aria-label': 'Role', on: on ? { change: on } : undefined }, ROLE_OPTS.map(([v, t]) => h('option', { value: v, text: full ? t : t.split(' · ')[0] }))); s.value = value; return s; };
  function openAddUser() {
    const email = h('input', { class: 'input', type: 'email', placeholder: 'name@dynamiqes.com', required: true, autocomplete: 'off' });
    const name = h('input', { class: 'input', placeholder: 'Full name', autocomplete: 'off' });
    const role = roleSelect('user', null, true); role.style.width = '100%';
    const pw = passwordField('Temporary password');
    dialog('Add user', 'They sign in with this email and the temporary password, then change it under Change password.', [
      h('label', { class: 'field' }, h('span', { text: 'Email' }), email),
      h('label', { class: 'field' }, h('span', { text: 'Name' }), name),
      h('label', { class: 'field' }, h('span', { text: 'Role' }), role, h('small', { text: 'Pick the lowest role that lets them do their work. You can change it later.' })),
      pw.el,
    ], 'Add user', async () => {
      try {
        await api('/admin/users', { method: 'POST', body: { email: email.value.trim(), name: name.value.trim(), role: role.value, password: pw.input.value } });
        toast(`${email.value.trim()} added as ${roleName(role.value)}. Remember to send them the password.`); if (currentPage() === 'users') pageUsers(); return true;
      } catch (err) { fail(err); return false; }
    });
  }
  function openResetPassword(u) {
    const pw = passwordField('New password');
    dialog(`Reset password for ${u.name || u.email}`, 'They are signed out everywhere and sign in again with this password.', [pw.el], 'Reset password', async () => {
      try { await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: pw.input.value } }); toast('Password reset; their other sessions were signed out'); return true; } catch (e) { fail(e); return false; }
    }, { width: 480 });
  }
  async function pageUsers() {
    const moved = navToken();
    loading();
    let users; try { users = await api('/admin/users'); } catch (e) { return moved() ? undefined : fail(e); }
    if (moved()) return;
    const put = (u, body) => api('/admin/users/' + u.id, { method: 'PUT', body });
    const update = async (u, body, msg, undoBody) => {
      try { await put(u, body); toast(msg, false, undoBody ? { undo: async () => { await put(u, undoBody); pageUsers(); } } : undefined); } catch (e) { fail(e); }
      pageUsers();
    };
    const who = (u) => u.name || u.email;
    const locked = (u) => u.locked_until && new Date(u.locked_until) > new Date();
    const statusOf = (u) => u.disabled ? 'disabled' : locked(u) ? 'locked' : 'active';
    const grid = h('div', { class: 'cards cards--grid' });
    const bar = filterBar({
      id: 'users', search: 'Search name or email…',
      seg: { key: 'role', label: 'Role', options: [['', 'Everyone'], ['superuser', 'Superusers'], ['admin', 'Admins'], ['user', 'Users']], def: '' },
      filters: [{ key: 'status', label: 'Status', options: [['active', 'Active'], ['disabled', 'Disabled'], ['locked', 'Locked']] },
        { key: 'seen', label: 'Last sign-in', options: [['week', 'This week'], ['month', 'More than 30 days ago'], ['never', 'Never signed in']] }],
      sort: { options: [['name', 'Name A–Z'], ['recent', 'Signed in recently'], ['role', 'Role']], def: 'name' },
      onChange: () => draw(),
    });
    const card = (u) => {
      const self = u.id === state.me.id, st = statusOf(u);
      return h('article', { class: 'ucard' + (st !== 'active' ? ' is-off' : '') },
        h('div', { class: 'ucard__top' }, avatar(who(u)), h('div', { class: 'ucard__who' }, h('b', { text: u.name || '—' }), h('span', { class: 'note', text: u.email })),
          menuBtn([{ label: 'Reset password…', onClick: () => openResetPassword(u) },
            locked(u) ? { label: 'Unlock', onClick: () => update(u, { unlock: true }, `${who(u)} unlocked`) } : null,
            self ? null : u.disabled ? { label: 'Enable', onClick: () => update(u, { disabled: false }, `${who(u)} can sign in again`) }
              : { label: 'Disable…', danger: true, onClick: async () => {
                if (!await ask(`${who(u)} is signed out everywhere and can't sign in until someone enables the account again.`, { title: `Disable ${who(u)}?`, ok: 'Disable' })) return;
                update(u, { disabled: true }, `${who(u)} disabled and signed out everywhere`, { disabled: false });
              } }], `Actions for ${who(u)}`)),
        h('div', { class: 'ucard__row' },
          self ? h('span', { class: 'role-badge role-badge--' + u.role, title: 'You can’t change your own role', text: roleName(u.role) + ' (you)' })
            : h('label', { class: 'ucard__role' }, h('span', { class: 'sr-only', text: 'Role' }), roleSelect(u.role, (e) => update(u, { role: e.target.value }, `${who(u)} is now ${roleName(e.target.value)}`, { role: u.role }))),
          st === 'active' ? badge('Active', 'badge--good') : st === 'locked' ? badge('Locked', 'badge--bad') : badge('Disabled', 'badge--bad')),
        h('div', { class: 'note', text: u.last_login_at ? `Last signed in ${ago(u.last_login_at)}` : 'Never signed in' }));
    };
    function draw() {
      const s = bar.state, t = s.q.toLowerCase(), now = Date.now();
      const counts = { all: users.length }; for (const [r] of ROLE_OPTS) counts[r] = users.filter((u) => u.role === r).length;
      bar.setCounts(counts);
      const rows = users.filter((u) => (!t || `${u.name || ''} ${u.email}`.toLowerCase().includes(t)) && (!s.role || u.role === s.role) && (!s.status || statusOf(u) === s.status)
        && (!s.seen || (s.seen === 'never' ? !u.last_login_at : u.last_login_at && (s.seen === 'week' ? now - new Date(u.last_login_at) < 7 * 864e5 : now - new Date(u.last_login_at) > 30 * 864e5))));
      const rank = { superuser: 0, admin: 1, user: 2 };
      rows.sort(s.sort === 'recent' ? (a, b) => new Date(b.last_login_at || 0) - new Date(a.last_login_at || 0) : s.sort === 'role' ? (a, b) => rank[a.role] - rank[b.role] || who(a).localeCompare(who(b)) : (a, b) => who(a).localeCompare(who(b)));
      bar.setResult(`${n(rows.length)} of ${plural(users.length, 'person', 'people')}`);
      grid.replaceChildren(...(rows.length ? rows.map(card) : [zeroState(bar, 'Nobody matches')]));
    }
    main.replaceChildren(
      top('Users', null,
        h('button', { class: 'btn btn--primary', type: 'button', text: '+ Add user', on: { click: openAddUser } })),
      h('details', { class: 'card role-help' }, h('summary', { class: 'card__head' }, h('h2', { text: 'What can each role do?' })),
        h('div', { class: 'card__body role-grid' }, ROLE_OPTS.map(([v, t]) => h('div', { class: 'role-card' }, h('span', { class: 'role-badge role-badge--' + v, text: t.split(' · ')[0] }), h('p', { text: t.split(' · ')[1] }))))),
      h('section', { class: 'card card--list' }, h('div', { class: 'card__head card__head--bar' }, bar.el), h('div', { class: 'card__body' }, grid)),
    );
    draw();
  }

  // =====================================================================================
  // Audit log
  // =====================================================================================
  const AUDIT_LABEL = { login: 'Signed in', 'login.failed': 'Wrong password', 'login.locked': 'Locked after wrong passwords', logout: 'Signed out', 'logout.timeout': 'Signed out (inactive)', 'password.changed': 'Changed own password',
    'products.checked': 'Checked the website for products', 'export.leads': 'Exported leads CSV', 'export.finetune': 'Exported approved answers', 'visitor.deleted': 'Deleted visitor data', 'prompt.changed': 'Changed DES instructions',
    'user.created': 'Added user', 'user.role_changed': 'Changed role', 'user.disabled': 'Disabled user', 'user.enabled': 'Enabled user', 'user.unlocked': 'Unlocked user', 'user.password_reset': 'Reset password',
    'settings.changed': 'Changed system settings', 'bans.lifted': 'Lifted bans', 'site.added': 'Allowed a website', 'site.removed': 'Removed a website',
    'share.created': 'Created share link', 'share.viewed': 'Share link opened', 'share.revoked': 'Revoked share link' };
  const TTL_NAME = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
  /** Audit row → icon name, a plain sentence and how much it matters: high (security), warn (worth a look), low (routine noise). */
  function auditEvent(a) {
    const d = a.detail || {}, who = a.user_email || 'Someone', t = a.target || '';
    const E = (icon, text, sev = '') => ({ icon, text, sev });
    switch (a.action) {
      case 'login': return E('key', `${who} signed in${d.remember ? ', kept signed in for 30 days' : ''}`);
      case 'login.failed':
        if (d.reason === 'disabled') return E('ban', `Sign-in refused for ${t}: the account is disabled`, 'warn');
        if (d.reason === 'unknown email') return E('help', `Someone tried to sign in with an unknown email: ${t}`, 'warn');
        return E('alert', `Wrong password for ${t}${d.attempts ? ` (attempt ${d.attempts})` : ''}`, d.attempts >= 3 ? 'high' : 'warn');
      case 'login.locked': return E('lock', `${t} was locked for 15 minutes after too many wrong passwords`, 'high');
      case 'logout': return E('logout', `${who} signed out`, 'low');
      case 'logout.timeout': return E('clock', `${t || who} was signed out after ${d.idle_minutes ?? 'some'} minutes without activity`, 'low');
      case 'password.changed': return E('key', `${who} changed their own password`);
      case 'export.leads': return E('download', `${who} downloaded the leads CSV${d.rows != null ? ` (${n(d.rows)} leads)` : ''}`, 'warn');
      case 'products.checked': return E('refresh', `${who} checked the website for products${d.added?.length ? ' · added ' + d.added.join(', ') : ''}${d.gone?.length ? ' · gone: ' + d.gone.join(', ') : ''}`);
      case 'export.finetune': return E('download', `${who} downloaded the approved answers${d.rows != null ? ` (${n(d.rows)})` : ''}`);
      case 'visitor.deleted': return E('trash', `${who} permanently deleted the data of visitor ${d.name || t}`, 'high');
      case 'prompt.changed': return E('edit', `${who} changed DES's instructions (version “${t}”)`, 'warn');
      case 'user.created': return E('user', `${who} added ${t} as ${roleName(d.role)}`, 'warn');
      case 'user.role_changed': return E('user', `${who} changed ${t}'s role from ${roleName(d.from)} to ${roleName(d.to)}`, 'warn');
      case 'user.disabled': return E('ban', `${who} disabled ${t}`, 'high');
      case 'user.enabled': return E('check', `${who} enabled ${t} again`, 'warn');
      case 'user.unlocked': return E('unlock', `${who} unlocked ${t}`);
      case 'user.password_reset': return E('key', `${who} reset the password of ${t}`, 'warn');
      case 'settings.changed': return E('sliders', `${who} changed system settings: ${Object.entries(d).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${v}`).join(', ') || 'no values'}`, 'warn');
      case 'bans.lifted': return E('unlock', `${who} lifted all bans${d.lifted != null ? ` (${n(d.lifted)} records)` : ''}`, 'warn');
      case 'site.added': return E('globe', `${who} allowed the chat on ${t}`, 'warn');
      case 'site.removed': return E('globe', `${who} removed the chat from ${t}`, 'warn');
      case 'share.created': return E('link', `${who} created a share link for ${d.visitor || 'a conversation'}${d.ttl ? `, works for ${TTL_NAME[d.ttl] || d.ttl}` : ''}`);
      case 'share.viewed': return E('eye', 'A share link was opened', 'low');
      case 'share.revoked': return E('link', `${who} revoked a share link`);
      default: return E('dot', `${who}: ${AUDIT_LABEL[a.action] || a.action}${t ? ' · ' + t : ''}`);
    }
  }
  const DETAIL_NAME = { remember: 'Kept signed in', attempts: 'Wrong passwords in a row', reason: 'Reason', idle_minutes: 'Minutes without activity', rows: 'Rows', name: 'Visitor', chars: 'Length (characters)', role: 'Role', from: 'From', to: 'To', lifted: 'Ban records removed', link_id: 'Link number', ttl: 'Works for', visitor: 'Visitor' };
  const detailValue = (k, v) => v === true ? 'Yes' : v === false ? 'No' : ['role', 'from', 'to'].includes(k) ? roleName(v) : k === 'ttl' ? (TTL_NAME[v] || v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
  function auditItem(a) {
    const ev = auditEvent(a), d = a.detail || {};
    const facts = [['What', AUDIT_LABEL[a.action] || a.action], a.target ? ['About', a.target] : null, ...Object.entries(d).map(([k, v]) => [DETAIL_NAME[k] || k.replace(/_/g, ' '), detailValue(k, v)]), a.ip ? ['IP address', a.ip] : null].filter(Boolean);
    return h('li', { class: 'tl__item' + (ev.sev ? ' is-' + ev.sev : '') },
      h('span', { class: 'tl__icon' }, icon(ev.icon)),
      h('div', { class: 'tl__main' },
        h('div', { class: 'tl__text' }, ev.text, ev.sev === 'high' ? h('span', null, ' ', badge('Security', 'badge--bad')) : null),
        h('div', { class: 'tl__meta' }, h('time', { datetime: a.at, text: timeF.format(new Date(a.at)) }), a.ip ? ` · ${a.ip}` : '',
          h('details', { class: 'tl__details' }, h('summary', { text: 'Details' }), h('dl', { class: 'kv' }, facts.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))))));
  }
  const AUDIT_SEG = [['', 'Everything'], ['security', 'Security only'], ['login', 'Sign-ins'], ['user', 'Users'], ['export', 'Exports'], ['share', 'Share links'], ['changes', 'Settings & instructions'], ['visitor', 'Visitor data']];
  const AUDIT_ACTIONS = { security: 'login.failed,login.locked,user.disabled,visitor.deleted', login: 'login,logout', changes: 'settings,prompt,site,bans' };
  async function pageAudit() {
    const SIZE = 50; let rows = [], total = 0, seq = 0;
    const listBox = h('div', null, skelLines(3)), moreBox = h('div', { class: 'loadmore' });
    const bar = filterBar({
      id: 'audit', search: 'Search a person’s email or what it was about…',
      seg: { key: 'kind', label: 'Show', options: AUDIT_SEG, def: '' },
      filters: [{ key: 'days', label: 'When', options: [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']] }],
      onChange: () => load(),
    });
    const load = async (append = false) => {
      const my = ++seq, s = bar.state;
      if (!append) listBox.replaceChildren(skelLines(3));
      const qs = new URLSearchParams({ limit: SIZE, offset: append ? rows.length : 0 });
      if (s.kind) qs.set('action', AUDIT_ACTIONS[s.kind] || s.kind); if (s.q) qs.set('user', s.q); if (s.days) qs.set('days', s.days);
      let page; try { const r = await api('/admin/audit?' + qs, { raw: true }); total = Number(r.headers.get('x-total-count')) || 0; page = await r.json(); } catch (e) { return fail(e); }
      if (my !== seq) return;
      rows = append ? rows.concat(page) : page;
      bar.setResult(`${n(rows.length)} of ${plural(total, 'event')}`);
      listBox.replaceChildren(rows.length ? timeline(rows, (a) => a.at, auditItem) : (bar.activeLabels().length ? zeroState(bar, 'Nothing matches') : empty('Nothing logged yet', 'Sign-ins, exports, deletions and changes appear here.')));
      moreBox.replaceChildren(rows.length < total ? h('button', { class: 'btn', type: 'button', text: `Show ${Math.min(SIZE, total - rows.length)} more`, on: { click: () => load(true) } }) : null);
    };
    main.replaceChildren(top('Audit log', null),
      h('section', { class: 'card card--list' }, h('div', { class: 'card__head card__head--bar' }, bar.el), h('div', { class: 'card__body' }, listBox, moreBox)));
    load();
  }

  // ---------------- layers ----------------
  let lastFocus = null;
  function openLayer(node, isModal = false) {
    closeLayer(); lastFocus = document.activeElement;
    const scrim = h('div', { class: 'scrim', on: { click: closeLayer } });
    layer.append(scrim, node);
    document.body.style.overflow = 'hidden';
    if (!isModal) node.querySelector('button')?.focus();
  }
  function closeLayer() {
    live.drawer = null;
    if (!layer.childElementCount) return;
    layer.replaceChildren(); document.body.style.overflow = '';
    lastFocus?.focus?.({ preventScroll: true });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.modal--confirm, .cmdk')) closeLayer(); });
  // conversation shortcuts: only while one is open, never while typing or with a dialog / menu on top
  let activePanel = null;
  function openShortcuts() {
    const rows = [['1 – 5', 'Record what happened on the call'], ['N', 'Add a note'], ['J / K', 'Next / previous lead'], ['Esc', 'Close or cancel'], ['Ctrl + K', 'Search everything'], ['?', 'This list']];
    const holder = h('div', { class: 'modal modal--confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', on: { keydown: (e) => { if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); holder.remove(); } } } },
      h('div', { class: 'scrim', on: { click: () => holder.remove() } }),
      h('div', { class: 'modal__card', style: { width: 'min(420px, 100%)' } }, h('div', { class: 'modal__head' }, h('h2', { text: 'Keyboard shortcuts' })),
        h('div', { class: 'modal__body' }, h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, h('kbd', { text: k })), h('dd', { text: v })]))),
        h('div', { class: 'modal__foot' }, h('button', { class: 'btn', type: 'button', text: 'Close', on: { click: () => holder.remove() } }))));
    document.body.append(holder); holder.querySelector('.modal__foot .btn').focus();
  }
  document.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal--confirm, .cmdk, .pop, .modal:not(.drawer)')) return;
    const p = activePanel && activePanel.el.isConnected ? activePanel : null;
    if (e.key === '?' && (p || currentPage() === 'conversations')) { e.preventDefault(); openShortcuts(); return; }
    if (!p) return;
    if (/^[1-5]$/.test(e.key)) { e.preventDefault(); p.press(Number(e.key) - 1); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault(); p.note(); }
    else if (e.key.toLowerCase() === 'j') { e.preventDefault(); p.move(1); }
    else if (e.key.toLowerCase() === 'k') { e.preventDefault(); p.move(-1); }
  });

  boot();
})();
