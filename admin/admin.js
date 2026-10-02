/* DES admin dashboard · vanilla JS, served by the backend at /admin. Data comes from /api/admin/* (ADMIN_TOKEN). */
(() => {
  'use strict';

  // ---------------- basics ----------------
  const TOKEN_KEY = 'des_admin_token';
  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch { } },
    del() { try { localStorage.removeItem(TOKEN_KEY); } catch { } },
  };
  let token = store.get();
  const $ = (s, r = document) => r.querySelector(s);
  const main = $('#main'), layer = $('#layer');
  const GENERAL = 'General';
  const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'];
  const state = { status: null, products: [], days: 30 };

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
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, bad = false) {
    const t = h('div', { class: 'toast' + (bad ? ' is-bad' : ''), role: 'status', text: msg });
    document.body.append(t); setTimeout(() => t.remove(), bad ? 5000 : 2600);
  }

  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const r = await fetch('/api' + path, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { showLogin('Your sign-in expired or the token changed. Sign in again.'); throw new Error('unauthorized'); }
    if (!r.ok) { let msg = `Request failed (${r.status})`; try { const j = await r.json(); msg = j.error ? j.error.replace(/_/g, ' ') : msg; } catch { } throw new Error(msg); }
    return raw ? r : r.json();
  }
  const fail = (e) => { if (e.message !== 'unauthorized') toast(e.message || 'Something went wrong', true); };

  const BLOCK_LABELS = {
    injection: 'Tried to override the bot’s instructions', off_topic: 'Off-topic question', price: 'Asked for pricing (redirected to demo)',
    abuse: 'Abusive message', support: 'Support request (sent to helpdesk)', too_long: 'Message too long', budget: 'Daily AI budget reached',
    turn_cap: 'Chat too long (handed to sales)', contact_echo: 'Reply repeated visitor contact', prompt_leak: 'Reply leaked instructions',
  };
  const blockLabel = (r) => String(r || '').split(',').map((x) => BLOCK_LABELS[x] || x.replace(/_/g, ' ')).join(', ');
  const STATUS_BADGE = { open: ['Open', ''], handed_off: ['Handed to sales', 'badge--info'], closed: ['Closed', ''], ended: ['Ended by DES (off-topic)', 'badge--bad'] };
  const statusBadge = (s) => { const [t, c] = STATUS_BADGE[s] || [s, '']; return h('span', { class: 'badge ' + c, text: t }); };
  const badge = (text, cls = '') => h('span', { class: 'badge ' + cls, text });
  const CONTACT_LABEL = { work_email: 'Work email', email: 'Personal email', mobile: 'Mobile', landline: 'Landline', viber: 'Viber', whatsapp: 'WhatsApp', wechat: 'WeChat', telegram: 'Telegram', signal: 'Signal', line: 'LINE' };
  const contactBadge = (type) => type ? badge(CONTACT_LABEL[type] || type, type === 'work_email' ? 'badge--good' : '') : null;
  const priceLike = (s) => /₱|\bPHP\s?\d|\bP\s?\d{1,3}(,\d{3})+|\b\d{1,3}(,\d{3})+(\.\d+)?\s?(pesos|php)\b/i.test(s || '');

  // ---------------- login / shell ----------------
  function showLogin(msg = '') {
    $('#app').hidden = true; $('#login').hidden = false;
    $('#loginErr').textContent = msg; $('#tokenInput').value = ''; $('#tokenInput').focus();
  }
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    token = $('#tokenInput').value.trim();
    try {
      const r = await fetch('/api/admin/status', { headers: { authorization: 'Bearer ' + token } });
      if (!r.ok) { $('#loginErr').textContent = r.status === 401 ? 'That token is not right. Copy the whole ADMIN_TOKEN value.' : `The backend answered ${r.status}. Is it running?`; return; }
      store.set(token); boot();
    } catch { $('#loginErr').textContent = 'Could not reach the backend. Is it running?'; }
  });
  function signOut() { store.del(); token = null; showLogin('Signed out.'); }

  async function boot() {
    if (!token) return showLogin();
    try { state.status = await api('/admin/status'); } catch (e) { if (e.message !== 'unauthorized') showLogin('Could not reach the backend. Is it running?'); return; }
    $('#login').hidden = true; $('#app').hidden = false;
    renderFoot(); refreshReviewCount();
    if (!location.hash) location.hash = '#/overview'; else route();
  }
  async function renderFoot() {
    const s = state.status, foot = $('#sideFoot'); foot.replaceChildren();
    let budget = null; try { budget = (await fetch('/api/health').then((r) => r.json())).budget; } catch { }
    foot.append(
      h('div', null, h('span', { class: 'dot' + (s.mock ? ' is-mock' : '') }), s.mock ? 'Mock mode (no AI key)' : 'Live AI'),
      h('div', { text: s.model }),
      budget ? h('div', { text: `Today: ${usd(budget.spent)} of ${usd(budget.budget)} budget` }) : null,
      h('button', { type: 'button', text: 'Sign out', on: { click: signOut } }),
    );
  }
  async function refreshReviewCount() {
    try { const q = await api('/admin/review-queue'); const b = $('#reviewCount'); b.hidden = !q.length; b.textContent = q.length; } catch { }
  }
  $('#nav').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-page]'); if (b) location.hash = '#/' + b.dataset.page; });
  window.addEventListener('hashchange', route);

  function route() {
    if ($('#app').hidden) return;
    const [page, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('is-on', b.dataset.page === page));
    closeLayer();
    const pages = { overview: pageOverview, conversations: pageConversations, leads: pageLeads, finetune: pageFinetune, review: pageReview, kb: pageKb, settings: pageSettings };
    (pages[page] || pageOverview)(arg);
    main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  }
  function top(title, sub, ...tools) {
    return h('div', { class: 'top' }, h('div', null, h('h1', { text: title }), sub ? h('p', { text: sub }) : null), tools.length ? h('div', { class: 'top__tools' }, tools) : null);
  }
  const loading = () => main.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
  const empty = (title, text) => h('div', { class: 'empty' }, h('b', { text: title }), text);

  // ---------------- charts ----------------
  /** Single-series vertical bars with hover tooltip, recessive grid, baseline, table toggle. data: [{label, value, tip}] */
  function barChart(data, { valueLabel = 'Value', height = 220 } = {}) {
    const wrap = h('div', { class: 'chart' });
    const tip = h('div', { class: 'tip', hidden: true });
    const tableBtn = h('button', { class: 'link-btn', type: 'button', text: 'Show as table' });
    let showTable = false;
    const draw = () => {
      wrap.replaceChildren();
      if (showTable) {
        wrap.append(h('div', { class: 'table-wrap', style: { maxHeight: height + 'px', overflow: 'auto' } }, h('table', null,
          h('thead', null, h('tr', null, h('th', { text: 'Day' }), h('th', { class: 'num', text: valueLabel }))),
          h('tbody', null, data.slice().reverse().map((d) => h('tr', null, h('td', { text: d.label }), h('td', { class: 'num', text: n(d.value) })))))));
        return;
      }
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
        if (i % every === 0 || i === data.length - 1) { const t = el('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick' }); t.textContent = d.label; }
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
    tableBtn.addEventListener('click', () => { showTable = !showTable; tableBtn.textContent = showTable ? 'Show as chart' : 'Show as table'; draw(); });
    const ro = new ResizeObserver(debounce(() => { if (!showTable && wrap.isConnected) draw(); }, 120)); ro.observe(wrap);
    requestAnimationFrame(draw);
    return { el: wrap, toggle: tableBtn };
  }
  /** Horizontal bars for ranked categories (one hue; label + value always visible). */
  function hbars(rows, { onPick, empty: emptyText = 'Nothing yet.' } = {}) {
    if (!rows.length) return h('div', { class: 'muted', text: emptyText });
    const max = Math.max(1, ...rows.map((r) => r.n));
    return h('div', { class: 'hbars' }, rows.map((r) => h('div', { class: 'hbar', title: `${r.label}: ${n(r.n)}` },
      onPick ? h('button', { class: 'link-btn hbar__label', type: 'button', text: r.label, style: { color: 'var(--ink)', fontWeight: 500, fontSize: '13px' }, on: { click: () => onPick(r) } }) : h('span', { class: 'hbar__label', text: r.label }),
      h('div', { class: 'hbar__track' }, h('div', { class: 'hbar__fill', style: { width: (r.n / max) * 100 + '%' } })),
      h('span', { class: 'hbar__n', text: n(r.n) }))));
  }

  // ---------------- overview ----------------
  async function pageOverview() {
    loading();
    let o, act;
    try { [o, act] = await Promise.all([api('/admin/overview?days=' + state.days), api('/admin/activity?limit=30')]); } catch (e) { return fail(e); }
    const k = o.kpi;
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, [7, 30, 90].map((d) => h('button', {
      type: 'button', class: d === state.days ? 'is-on' : '', text: d + ' days', 'aria-pressed': String(d === state.days), on: { click: () => { state.days = d; pageOverview(); } },
    })));
    const tile = (label, value, sub, accent) => h('div', { class: 'card kpi' + (accent ? ' kpi--accent' : '') }, h('div', { class: 'kpi__label', text: label }), h('div', { class: 'kpi__value', text: value }), sub ? h('div', { class: 'kpi__sub', text: sub }) : null);
    const thumbsTotal = k.thumbs_up + k.thumbs_down;
    const chart = barChart(o.daily.map((d) => ({ label: dayf.format(new Date(d.day + 'T00:00:00Z')), value: d.questions, tip: `${n(d.questions)} questions · ${n(d.conversations)} chats` })), { valueLabel: 'Questions' });

    main.replaceChildren(
      top('Overview', `What DES did in the last ${o.days} days.`, seg),
      h('div', { class: 'grid grid--kpi' },
        tile('Chats', n(k.conversations), `${n(k.visitors)} visitors`),
        tile('Questions asked', n(k.questions), k.conversations ? `${(k.questions / k.conversations).toFixed(1)} per chat` : null),
        tile('Leads captured', n(k.leads), `${n(k.demos)} asked for a demo`, true),
        tile('Handed to sales', n(k.handoffs), 'consultant follow-ups'),
        tile('Answer rating', k.avg_rating ? `${k.avg_rating.toFixed(1)} / 5` : '—', k.surveys ? `${n(k.surveys)} surveys` : 'no surveys yet'),
        tile('Thumbs up', thumbsTotal ? `${Math.round((k.thumbs_up / thumbsTotal) * 100)}%` : '—', thumbsTotal ? `${n(k.thumbs_up)} up · ${n(k.thumbs_down)} down` : 'no votes yet'),
        tile('Approved answers used', n(k.approved_used), 'replies based on your answers'),
        tile('AI cost', usd(k.cost_usd), `${n(k.ai_calls)} AI calls`),
      ),
      h('div', { class: 'grid grid--2', style: { marginTop: '16px' } },
        h('div', { class: 'stack' },
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Visitor questions per day' }), h('p', { text: 'Days are in UTC. Hover a bar for details.' })), chart.toggle), h('div', { class: 'card__body' }, chart.el)),
          h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' } },
            h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'What visitors ask about' }), h('p', { text: 'Questions by product. Click one to fine-tune it.' }))),
              h('div', { class: 'card__body' }, hbars(o.products.map((p) => ({ label: p.product, n: p.n })), { onPick: (r) => { location.hash = '#/finetune/' + encodeURIComponent(r.label); }, empty: 'No questions yet.' }))),
            h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Leads by product interest' }))),
              h('div', { class: 'card__body' }, hbars(o.leadProducts.map((p) => ({ label: p.product, n: p.n })), { empty: 'No leads yet.' }))),
          ),
          h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Replies the safety rules changed' }), h('p', { text: 'The bot answered with a standard message instead of its own reply.' }))),
            h('div', { class: 'card__body' }, hbars(o.blocked.map((b) => ({ label: blockLabel(b.reason), n: b.n })), { empty: 'None in this period.' }))),
        ),
        h('section', { class: 'card', style: { alignSelf: 'start' } },
          h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Latest activity' }), h('p', { text: 'Chats, leads, handoffs and feedback, newest first.' }))),
          act.length ? h('ul', { class: 'feed' }, act.map(feedItem)) : empty('No activity yet', 'Chats will show up here as soon as visitors use the widget.')),
      ),
    );
  }
  function feedItem(a) {
    const map = {
      conversation: ['💬', '', 'started a chat'], lead: ['⭐', 'lead', a.status === 'demo' ? 'asked for a demo' : 'became a lead'],
      handoff: ['🤝', 'handoff', 'was handed to sales'],
      feedback: a.status === 'down' ? ['👎', 'down', 'disliked an answer'] : a.status === 'up' ? ['👍', 'up', 'liked an answer'] : ['⭐', '', 'rated the chat'],
    };
    const [icon, cls, verb] = map[a.type] || ['•', '', a.type];
    return h('li', { tabindex: '0', on: { click: () => a.conversation_id && openConversation(a.conversation_id), keydown: (e) => { if (e.key === 'Enter' && a.conversation_id) openConversation(a.conversation_id); } } },
      h('span', { class: 'feed__icon ' + cls, 'aria-hidden': 'true', text: icon }),
      h('div', { class: 'feed__text' }, h('b', { text: a.who || 'Visitor' }), ' ', verb, a.detail ? h('div', { text: a.detail }) : null),
      h('time', { datetime: a.at, text: ago(a.at) }));
  }

  // ---------------- conversations ----------------
  async function pageConversations() {
    const filters = { q: '', status: '', product: '', offset: 0 };
    const tbody = h('tbody'), moreBtn = h('button', { class: 'btn', type: 'button', text: 'Load more', hidden: true });
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search name or message…', 'aria-label': 'Search conversations' });
    const status = h('select', { class: 'input', 'aria-label': 'Status' }, h('option', { value: '', text: 'All statuses' }), h('option', { value: 'open', text: 'Open' }), h('option', { value: 'handed_off', text: 'Handed to sales' }), h('option', { value: 'closed', text: 'Closed' }), h('option', { value: 'ended', text: 'Ended by DES' }));
    const product = h('select', { class: 'input', 'aria-label': 'Product' }, h('option', { value: '', text: 'All products' }), state.status.products.filter((p) => p !== GENERAL).map((p) => h('option', { value: p, text: p })));
    const load = async (append = false) => {
      if (!append) { filters.offset = 0; tbody.replaceChildren(h('tr', null, h('td', { colspan: 7, class: 'loading', text: 'Loading…' }))); }
      const qs = new URLSearchParams({ limit: 50, offset: filters.offset }); if (filters.q) qs.set('q', filters.q); if (filters.status) qs.set('status', filters.status); if (filters.product) qs.set('product', filters.product);
      let rows; try { rows = await api('/admin/conversations?' + qs); } catch (e) { return fail(e); }
      if (!append) tbody.replaceChildren();
      if (!rows.length && !append) tbody.append(h('tr', null, h('td', { colspan: 7 }, empty('No conversations found', 'Try another filter.'))));
      rows.forEach((c) => tbody.append(h('tr', { class: 'is-click', tabindex: '0', on: { click: () => openConversation(c.id), keydown: (e) => { if (e.key === 'Enter') openConversation(c.id); } } },
        h('td', { class: 'muted', text: when(c.started_at), style: { whiteSpace: 'nowrap' } }),
        h('td', null, h('div', { text: c.name, style: { fontWeight: 600 } }), h('div', { class: 'muted', text: c.contact || '' }), contactBadge(c.contact_type)),
        h('td', null, h('div', { class: 'clip', text: c.first_question || '—', title: c.first_question || '' }), c.summary ? h('div', { class: 'muted clip', text: c.summary }) : null),
        h('td', null, h('div', { class: 'badges' }, (c.products || []).map((p) => badge(p)))),
        h('td', { class: 'num', text: c.turns }),
        h('td', null, h('div', { class: 'badges' }, c.demo ? badge('Demo', 'badge--brand') : c.has_lead ? badge('Lead', 'badge--brand') : null,
          c.approved_used ? badge(`Approved ×${c.approved_used}`, 'badge--good') : null, c.thumbs_down ? badge(`👎 ${c.thumbs_down}`, 'badge--bad') : null,
          c.rating ? badge(`★ ${c.rating}`) : null, c.lang === 'fil' ? badge('Filipino') : null)),
        h('td', null, statusBadge(c.status)))));
      moreBtn.hidden = rows.length < 50; filters.offset += rows.length;
    };
    search.addEventListener('input', debounce(() => { filters.q = search.value.trim(); load(); }));
    status.addEventListener('change', () => { filters.status = status.value; load(); });
    product.addEventListener('change', () => { filters.product = product.value; load(); });
    moreBtn.addEventListener('click', () => load(true));
    main.replaceChildren(
      top('Conversations', 'Every chat with DES. Open one to read it and turn a reply into an approved answer.'),
      h('section', { class: 'card' },
        h('div', { class: 'card__head' }, h('div', { class: 'filters' }, search, status, product)),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Started', 'Visitor', 'First question', 'Products', 'Turns', 'Signals', 'Status'].map((t, i) => h('th', { text: t, class: i === 4 ? 'num' : null })))), tbody)),
        h('div', { class: 'card__body', style: { textAlign: 'center' } }, moreBtn)),
    );
    load();
  }

  async function openConversation(id) {
    const body = h('div', { class: 'drawer__body' }, h('div', { class: 'loading', text: 'Loading…' }));
    const head = h('div', { class: 'drawer__head' }, h('h2', { text: 'Conversation' }), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '✕', on: { click: closeLayer } }));
    openLayer(h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Conversation' }, head, body));
    let c; try { c = await api(`/admin/conversations/${id}/detail`); } catch (e) { closeLayer(); return fail(e); }
    const goldenById = Object.fromEntries(c.golden.map((g) => [String(g.id), g]));
    const thumbs = {}; c.feedback.filter((f) => f.kind === 'thumb' && f.message_id).forEach((f) => { thumbs[f.message_id] = f.thumb; });
    const reasons = {}; c.feedback.filter((f) => f.kind === 'thumb_reason' && f.message_id).forEach((f) => { reasons[f.message_id] = (f.reasons || []).join(', '); });
    head.replaceChildren(
      h('div', null, h('h2', { text: c.name }), h('div', { class: 'meta-line', style: { marginTop: '4px' } }, statusBadge(c.status), when(c.started_at), c.lang === 'fil' ? badge('Filipino') : null)),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '✕', on: { click: closeLayer } }));
    let lastUser = null;
    const thread = h('div', { class: 'thread' });
    for (const m of c.messages) {
      if (m.role === 'user') {
        lastUser = m;
        thread.append(h('div', { class: 'msg msg--user' }, h('div', { class: 'msg__b', text: m.content }), h('div', { class: 'msg__meta' }, m.product ? badge(m.product) : null, when(m.created_at))));
      } else if (m.role === 'assistant') {
        const q = lastUser;
        const used = (m.golden_ids || []).map((gid) => goldenById[String(gid)]).filter(Boolean);
        thread.append(h('div', { class: 'msg msg--assistant' },
          h('div', { class: 'msg__b', html: fmt(m.content) }),
          h('div', { class: 'msg__meta' }, when(m.created_at),
            used.map((g) => badge('Approved: ' + g.question.slice(0, 40) + (g.question.length > 40 ? '…' : ''), 'badge--good')),
            m.blocked_reason ? badge(blockLabel(m.blocked_reason), 'badge--bad') : null,
            thumbs[m.id] === 1 ? badge('👍 liked', 'badge--good') : thumbs[m.id] === -1 ? badge('👎 ' + (reasons[m.id] || 'disliked'), 'badge--bad') : null,
            q ? h('button', { class: 'link-btn', type: 'button', text: 'Save as approved answer', on: { click: () => openGolden({ question: q.content, ideal_answer: m.content, product: m.product || q.product || GENERAL, message_id: Number(m.id) }) } }) : null)));
      } else if (m.role === 'tool') {
        const label = { save_lead: '⭐ Saved lead details', book_demo: '📅 Booked a demo request', handoff_to_human: '🤝 Handed to a consultant', search_kb: '🔎 Searched the website', get_open_jobs: '💼 Looked up open jobs' }[m.tool_name] || m.tool_name;
        thread.append(h('div', { class: 'msg msg--tool', text: label }));
      }
    }
    if (!c.messages.length) thread.append(empty('No messages', 'The visitor opened the chat but did not send anything.'));
    const lead = c.lead;
    body.replaceChildren(
      h('section', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card__body' }, h('dl', { class: 'kv' },
        h('dt', { text: 'Contact' }), h('dd', null, c.contact || '—', ' ', contactBadge(c.contact_type)),
        h('dt', { text: 'Marketing opt-in' }), h('dd', { text: c.marketing_opt_in ? 'Yes' : 'No' }),
        h('dt', { text: 'First page' }), h('dd', null, c.first_page_url ? h('a', { href: c.first_page_url, target: '_blank', rel: 'noopener', text: c.first_page_url }) : '—'),
        c.summary ? [h('dt', { text: 'Summary' }), h('dd', { text: c.summary })] : null,
        lead ? [h('dt', { text: 'Lead' }), h('dd', null, h('div', { class: 'badges' }, (lead.product_interest || []).map((p) => badge(p, 'badge--brand')), lead.demo_requested ? badge('Demo requested', 'badge--brand') : null), lead.need ? h('div', { text: lead.need, style: { marginTop: '4px' } }) : null,
          h('div', { class: 'muted', text: [lead.company, lead.industry, lead.team_size && lead.team_size + ' people', lead.current_system].filter(Boolean).join(' · ') }))] : null,
        c.handoffs.length ? [h('dt', { text: 'Handoffs' }), h('dd', { text: c.handoffs.map((x) => x.reason).join('; ') })] : null,
      ))),
      thread,
      h('div', { style: { marginTop: '28px', paddingTop: '14px', borderTop: '1px solid var(--line)' } },
        h('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Delete this visitor’s data', on: { click: async () => {
          if (!confirm(`Permanently delete ${c.name}'s details, chats and lead? Use this for Data Privacy Act erasure requests. This cannot be undone.`)) return;
          try { await api('/admin/visitors/' + c.visitor_id, { method: 'DELETE' }); toast('Visitor data deleted'); closeLayer(); route(); } catch (e) { fail(e); }
        } } }), h('span', { class: 'note', style: { marginLeft: '8px' }, text: 'For erasure requests under the Data Privacy Act.' })),
    );
  }

  // ---------------- leads ----------------
  async function pageLeads() {
    loading();
    let rows; try { rows = await api('/admin/leads'); } catch (e) { return fail(e); }
    const dl = h('button', { class: 'btn', type: 'button', text: 'Download CSV', on: { click: async () => {
      try { const r = await api('/admin/export/leads.csv', { raw: true }); const url = URL.createObjectURL(await r.blob()); const a = h('a', { href: url, download: `des-leads-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); } catch (e) { fail(e); }
    } } });
    main.replaceChildren(
      top('Leads', 'Visitors who shared a need. Update the status as sales follows up.', dl),
      h('section', { class: 'card' }, rows.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Date', 'Visitor', 'Need', 'Products', 'Company', 'Opt-in', 'Status'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows.map((l) => {
          const sel = h('select', { class: 'input', 'aria-label': 'Lead status', on: { click: (e) => e.stopPropagation(), change: async (e) => { try { await api('/admin/leads/' + l.id, { method: 'PUT', body: { status: e.target.value } }); toast('Status updated'); } catch (err) { fail(err); } } } },
            LEAD_STATUSES.map((s) => h('option', { value: s, text: s[0].toUpperCase() + s.slice(1), selected: s === l.status })));
          return h('tr', { class: 'is-click', on: { click: () => l.conversation_id && openConversation(l.conversation_id) } },
            h('td', { class: 'muted', text: when(l.created_at), style: { whiteSpace: 'nowrap' } }),
            h('td', null, h('div', { text: l.name, style: { fontWeight: 600 } }), h('div', { class: 'muted', text: l.contact || '' }), contactBadge(l.contact_type)),
            h('td', null, h('div', { class: 'clip', text: l.need || '—', title: l.need || '' }), l.summary ? h('div', { class: 'muted clip', text: l.summary }) : null),
            h('td', null, h('div', { class: 'badges' }, (l.product_interest || []).map((p) => badge(p, 'badge--brand')), l.demo_requested ? badge('Demo', 'badge--brand') : null)),
            h('td', null, h('div', { text: l.company || '—' }), h('div', { class: 'muted', text: [l.industry, l.team_size].filter(Boolean).join(' · ') })),
            h('td', { text: l.marketing_opt_in ? 'Yes' : 'No' }),
            h('td', null, sel));
        })))) : empty('No leads yet', 'DES saves a lead as soon as a visitor explains what they need.')),
    );
  }

  // ---------------- fine-tune ----------------
  async function pageFinetune(productArg) {
    loading();
    try { state.products = await api('/admin/products'); } catch (e) { return fail(e); }
    const current = state.products.find((p) => p.product === productArg) || state.products[0];
    const list = h('nav', { class: 'card plist', 'aria-label': 'Products' });
    state.products.forEach((p, i) => {
      if (p.product === GENERAL) list.append(h('div', { class: 'plist__sep' }));
      list.append(h('button', { type: 'button', class: p.product === current.product ? 'is-on' : '', 'aria-current': p.product === current.product ? 'true' : null, on: { click: () => { location.hash = '#/finetune/' + encodeURIComponent(p.product); } } },
        h('b', { text: p.product === GENERAL ? 'General (all products)' : p.product }),
        p.approved ? h('span', { class: 'badge badge--good', text: p.approved }) : h('span'),
        h('small', null, `${n(p.questions_30d)} questions · ${n(p.approved)} answers`, p.thumbs_down ? h('span', { class: 'warn', text: ` · ${p.thumbs_down} 👎` }) : null)));
    });
    const detail = h('div', { class: 'stack' }, h('div', { class: 'loading', text: 'Loading…' }));
    main.replaceChildren(
      top('Fine-tune answers', 'Teach DES per product. Approved answers are used word-for-word in facts and links when a visitor asks something similar. Product notes add facts the website doesn’t have yet.',
        h('button', { class: 'btn btn--primary', type: 'button', text: '+ Add approved answer', on: { click: () => openGolden({ product: current.product }) } })),
      h('div', { class: 'ft' }, list, detail));
    renderProduct(current.product, detail);
  }

  async function renderProduct(name, detail, tab = 'answers') {
    let d; try { d = await api('/admin/products/' + encodeURIComponent(name)); } catch (e) { return fail(e); }
    const p = state.products.find((x) => x.product === name) || {};
    const isGeneral = name === GENERAL;
    const tabs = [['answers', 'Approved answers', d.golden.length], ['questions', 'Visitor questions', d.questions.length], ['notes', 'Product notes', null]];
    if (!isGeneral) tabs.push(['pages', 'Website pages', d.docs.length]);
    const tabBar = h('div', { class: 'ptabs', role: 'tablist' });
    const panel = h('div', { class: 'card__body', role: 'tabpanel' });
    const show = (key) => {
      tab = key;
      tabBar.querySelectorAll('button').forEach((b) => { const on = b.dataset.tab === key; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
      panel.replaceChildren(({ answers: tabAnswers, questions: tabQuestions, notes: tabNotes, pages: tabPages }[key])(d, name, () => renderProduct(name, detail, tab)));
    };
    tabs.forEach(([key, label, count]) => tabBar.append(h('button', { type: 'button', role: 'tab', 'data-tab': key, on: { click: () => show(key) } }, label, count != null ? h('span', { class: 'n', text: count }) : null)));
    detail.replaceChildren(
      h('section', { class: 'card' },
        h('div', { class: 'card__head' }, h('div', null, h('h2', { text: isGeneral ? 'General (all products)' : name }),
          h('p', { text: isGeneral ? 'Answers here are used for any product, e.g. company, contact or demo questions.' : `${n(p.questions_30d)} questions in 30 days · ${n(p.leads)} leads · ${n(p.chunks)} website passages` }))),
        h('div', { class: 'card__body' }, testBox(name))),
      h('section', { class: 'card' }, tabBar, panel));
    show(tab);
  }

  function testBox(product) {
    const input = h('input', { class: 'input', type: 'text', placeholder: product === GENERAL ? 'Type a question a visitor might ask…' : `Ask what a visitor might ask about ${product}…`, 'aria-label': 'Test question' });
    const lang = h('select', { class: 'input', 'aria-label': 'Language' }, h('option', { value: 'auto', text: 'Auto language' }), h('option', { value: 'en', text: 'English' }), h('option', { value: 'fil', text: 'Filipino' }));
    const btn = h('button', { class: 'btn btn--primary', type: 'submit', text: 'Ask DES' });
    const out = h('div', { class: 'test__out', 'aria-live': 'polite' });
    const form = h('form', { class: 'test' },
      h('div', { style: { fontWeight: 700, marginBottom: '8px' } }, 'Test a question ', h('span', { class: 'note', text: '· runs the real bot with your current answers and notes. Uses a little AI credit; nothing is saved.' })),
      h('div', { class: 'test__row' }, input, lang, btn), out);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const question = input.value.trim(); if (!question) return input.focus();
      btn.disabled = true; btn.textContent = 'Asking…'; out.replaceChildren(h('div', { class: 'muted', text: 'DES is thinking…' }));
      try {
        const r = await api('/admin/test', { method: 'POST', body: { question, lang: lang.value, product: product === GENERAL ? 'auto' : product } });
        const urls = [...new Map(r.sources.map((s) => [s.url, s])).values()].slice(0, 4);
        out.replaceChildren(
          h('div', { class: 'bubble', html: fmt(r.answer) }),
          h('div', { class: 'meta-line' },
            r.approved.length ? r.approved.map((a) => badge(`Used approved answer (${Math.round(a.score * 100)}% match): ${a.question.slice(0, 50)}`, 'badge--good')) : badge('No approved answer matched'),
            r.notes_used ? badge('Product notes used', 'badge--info') : null,
            r.blocked ? badge('Changed by safety rules: ' + blockLabel(r.blocked), 'badge--bad') : null,
            badge('Product: ' + r.product), `${(r.ms / 1000).toFixed(1)} s`),
          urls.length ? h('div', { class: 'meta-line' }, 'Website sources:', urls.map((s) => h('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title || s.url }))) : null,
          h('div', null, h('button', { class: 'link-btn', type: 'button', text: r.approved.length ? 'Not right? Edit the matched answer' : 'Not right? Save a better answer for this question', on: { click: async () => {
            if (r.approved.length) { const all = await api('/admin/golden'); const g = all.find((x) => String(x.id) === String(r.approved[0].id)); if (g) return openGolden(g); }
            openGolden({ question, ideal_answer: r.answer, product: r.product });
          } } })));
      } catch (e) { out.replaceChildren(); fail(e); }
      finally { btn.disabled = false; btn.textContent = 'Ask DES'; }
    });
    return form;
  }

  function tabAnswers(d, name, refresh) {
    const add = h('button', { class: 'btn', type: 'button', text: '+ Add approved answer', on: { click: () => openGolden({ product: name }) } });
    if (!d.golden.length) return h('div', null, empty('No approved answers yet', `Add the answers you want DES to give about ${name === GENERAL ? 'general topics' : name}. Start with questions visitors really ask (see the Visitor questions tab).`), h('div', { style: { textAlign: 'center' } }, add));
    return h('div', null, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: '8px', flexWrap: 'wrap' } },
      h('span', { class: 'note', text: 'DES uses an answer when a visitor’s question matches its question or one of its variations.' }), add),
    d.golden.map((g) => {
      const vars = String(g.variations || '').split('\n').filter(Boolean);
      const toggle = h('input', { type: 'checkbox', checked: g.active !== false, 'aria-label': 'Use in live chats' });
      toggle.addEventListener('change', async () => { try { await api('/admin/golden/' + g.id, { method: 'PUT', body: { active: toggle.checked } }); toast(toggle.checked ? 'Answer is live' : 'Answer paused'); refresh(); } catch (e) { toggle.checked = !toggle.checked; fail(e); } });
      return h('article', { class: 'qa' + (g.active === false ? ' is-off' : '') },
        h('div', { class: 'qa__q' }, h('span', { text: g.question }), g.active === false ? badge('Paused') : null),
        vars.length ? h('div', { class: 'qa__vars', text: 'Also matches: ' + vars.join(' · ') }) : null,
        h('div', { class: 'qa__a', html: fmt(g.ideal_answer) }),
        h('div', { class: 'qa__foot' },
          h('label', { class: 'toggle' }, toggle, 'Live'),
          h('span', { text: g.use_count ? `Used ${n(g.use_count)}× · last ${ago(g.last_used_at)}` : 'Not used yet' }),
          h('span', { class: 'sp' }),
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Edit', on: { click: () => openGolden(g) } }),
          h('button', { class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete', on: { click: async () => { if (!confirm('Delete this approved answer?')) return; try { await api('/admin/golden/' + g.id, { method: 'DELETE' }); toast('Deleted'); refresh(); } catch (e) { fail(e); } } } })));
    }));
  }

  function tabQuestions(d, name) {
    if (!d.questions.length) return empty('No questions yet', `Questions visitors ask about ${name === GENERAL ? 'general topics' : name} will appear here.`);
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'Visitor asked' }), h('th', { text: 'DES answered' }), h('th', { text: '' }))),
      h('tbody', null, d.questions.map((q) => h('tr', null,
        h('td', { style: { minWidth: '220px' } }, h('div', { text: q.question, style: { fontWeight: 600 } }), h('div', { class: 'muted', text: ago(q.created_at) })),
        h('td', null, h('div', { class: 'clip', text: q.answer || '—', title: q.answer || '', style: { maxWidth: '420px' } }),
          h('div', { class: 'badges', style: { marginTop: '4px' } }, q.thumb === -1 ? badge('👎 disliked', 'badge--bad') : q.thumb === 1 ? badge('👍 liked', 'badge--good') : null,
            q.golden_ids ? badge('Used approved answer', 'badge--good') : null, q.blocked_reason ? badge(blockLabel(q.blocked_reason), 'badge--bad') : null)),
        h('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
          h('button', { class: 'btn btn--sm', type: 'button', text: 'Write approved answer', on: { click: () => openGolden({ question: q.question, ideal_answer: q.answer || '', product: name, message_id: q.answer_id ? Number(q.answer_id) : null }) } }), ' ',
          h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Open chat', on: { click: () => openConversation(q.conversation_id) } })))))));
  }

  function tabNotes(d, name, refresh) {
    const ta = h('textarea', { class: 'input', rows: 10, maxlength: 6000, placeholder: name === GENERAL ? 'e.g. We are closed on 24–25 December. Demo slots are booked within 2 business days.' : `e.g. ${name} now supports … (launched Sept 2026).\nAlways mention the free business analysis.\nDo not promise integration with … yet.` });
    ta.value = d.notes || '';
    const save = h('button', { class: 'btn btn--primary', type: 'button', text: 'Save notes', on: { click: async () => { try { await api('/admin/products/' + encodeURIComponent(name) + '/notes', { method: 'PUT', body: { notes: ta.value } }); toast('Notes saved. DES uses them from the next message.'); refresh(); } catch (e) { fail(e); } } } });
    return h('div', null,
      h('div', { class: 'callout', style: { marginBottom: '12px' } }, name === GENERAL
        ? 'DES does not read General notes automatically, because they have no product to trigger them. Put company-wide facts in Settings → Company facts instead, or add General approved answers.'
        : `DES reads these notes whenever a visitor asks about ${name}. Use them for facts the website doesn’t say yet, corrections, and how to talk about the product. They override older website text. Don’t put prices here: replies with prices are replaced by the standard “book a free analysis” message.`),
      h('label', { class: 'field' }, h('span', { text: 'Notes for DES' }), ta, h('small', { text: d.notes_updated_at ? 'Last saved ' + when(d.notes_updated_at) : 'Not saved yet' })),
      save);
  }

  function tabPages(d, name, refresh) {
    if (!d.docs.length) return empty('No website pages tagged', `No product page for ${name} was found in the website scrape.`);
    return h('div', null, h('p', { class: 'note', style: { marginTop: 0 }, text: 'Pages DES reads for this product. Pause a page to stop DES using it; re-read it after the website changes.' }),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', { text: 'Page' }), h('th', { class: 'num', text: 'Passages' }), h('th', { text: 'Updated' }), h('th', { text: 'Used by DES' }), h('th', { text: '' }))),
        h('tbody', null, d.docs.map((doc) => kbRow(doc, refresh, { showKind: false }))))));
  }

  function kbRow(doc, refresh, { showKind = true } = {}) {
    const toggle = h('input', { type: 'checkbox', checked: doc.status === 'active', 'aria-label': 'Used by DES' });
    toggle.addEventListener('change', async () => { try { await api('/admin/kb/' + doc.id, { method: 'PUT', body: { status: toggle.checked ? 'active' : 'archived' } }); toast(toggle.checked ? 'Page is used again' : 'Page paused'); } catch (e) { toggle.checked = !toggle.checked; fail(e); } });
    const reread = h('button', { class: 'btn btn--sm', type: 'button', text: 'Re-read', on: { click: async () => {
      reread.disabled = true; reread.textContent = 'Reading…';
      try { const r = await api('/admin/ingest', { method: 'POST', body: { url: doc.url } }); toast(r.skipped ? 'No changes on that page' : 'Page re-read'); refresh?.(); } catch (e) { fail(e); } finally { reread.disabled = false; reread.textContent = 'Re-read'; }
    } } });
    return h('tr', null,
      h('td', null, h('a', { href: doc.url, target: '_blank', rel: 'noopener', text: doc.title || doc.url }), h('div', { class: 'muted clip', text: doc.url.replace(/^https?:\/\//, '') })),
      showKind ? h('td', null, badge(doc.kind || 'page')) : null,
      h('td', { class: 'num', text: doc.chunks }),
      h('td', { class: 'muted', text: when(doc.updated_at), style: { whiteSpace: 'nowrap' } }),
      h('td', null, h('label', { class: 'toggle' }, toggle, h('span', { class: 'sr-only', text: 'Used by DES' }))),
      h('td', { style: { textAlign: 'right' } }, reread));
  }

  // ---------------- approved-answer editor ----------------
  function openGolden(init = {}) {
    const isEdit = !!init.id;
    const products = state.status.products;
    const product = h('select', { class: 'input' }, products.map((p) => h('option', { value: p, text: p === GENERAL ? 'General (all products)' : p, selected: (init.product || GENERAL) === p })));
    const question = h('input', { class: 'input', type: 'text', maxlength: 500, required: true, value: init.question || '', placeholder: 'e.g. Does IQ People compute 13th month pay?' });
    const variations = h('textarea', { class: 'input', rows: 3, maxlength: 4000, placeholder: 'Can your payroll compute the 13th month?\nKaya ba ng IQ People mag compute ng 13th month?' });
    variations.value = init.variations || '';
    const answer = h('textarea', { class: 'input', rows: 7, maxlength: 3000, required: true, placeholder: 'Write the answer the way DES should say it. Short paragraphs, **bold**, - bullet lists and dynamiqes.com links work.' });
    answer.value = init.ideal_answer || '';
    const active = h('input', { type: 'checkbox', checked: init.active !== false });
    const preview = h('div', { class: 'preview' }); const warn = h('div', { class: 'note', style: { color: 'var(--bad)', marginTop: '6px' }, hidden: true, text: 'This answer mentions a price. DES replaces any reply with prices by the standard “book a free analysis” message, so visitors won’t see it.' });
    const sync = () => { preview.innerHTML = answer.value.trim() ? fmt(answer.value) : '<span class="muted">Preview appears here.</span>'; warn.hidden = !priceLike(answer.value); };
    answer.addEventListener('input', sync); sync();
    const save = h('button', { class: 'btn btn--primary', type: 'submit', text: isEdit ? 'Save changes' : 'Save answer' });
    const form = h('form', { class: 'modal__card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Approved answer' },
      h('div', { class: 'modal__head' }, h('div', null, h('h2', { text: isEdit ? 'Edit approved answer' : 'New approved answer' }), h('p', { text: 'When a visitor asks something similar, DES bases its reply on this answer and keeps its facts and links.' })),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '✕', on: { click: closeLayer } })),
      h('div', { class: 'modal__body' },
        h('label', { class: 'field' }, h('span', { text: 'Product' }), product, h('small', { text: 'DES only uses this answer when the visitor is asking about this product. General answers work for any product.' })),
        h('label', { class: 'field' }, h('span', { text: 'Visitor question' }), question),
        h('label', { class: 'field' }, h('span', { text: 'Other ways visitors ask this' }), variations, h('small', { text: 'Optional, one per line. Add rewordings and Filipino or Taglish versions so DES recognises them.' })),
        h('label', { class: 'field' }, h('span', { text: 'Approved answer' }), answer),
        h('div', { class: 'field' }, h('span', { text: 'How it will look' }), preview, warn),
        h('label', { class: 'toggle' }, active, 'Use this answer in live chats')),
      h('div', { class: 'modal__foot' },
        isEdit ? h('button', { class: 'btn btn--danger btn--ghost', type: 'button', text: 'Delete', on: { click: async () => { if (!confirm('Delete this approved answer?')) return; try { await api('/admin/golden/' + init.id, { method: 'DELETE' }); toast('Deleted'); closeLayer(); route(); } catch (e) { fail(e); } } } }) : null,
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

  // ---------------- needs review ----------------
  async function pageReview() {
    loading();
    let q, s; try { [q, s] = await Promise.all([api('/admin/review-queue'), api('/admin/feedback/summary')]); } catch (e) { return fail(e); }
    const tile = (label, value, sub) => h('div', { class: 'card kpi' }, h('div', { class: 'kpi__label', text: label }), h('div', { class: 'kpi__value', text: value }), sub ? h('div', { class: 'kpi__sub', text: sub }) : null);
    const resolved = (s.resolved_yes || 0) + (s.resolved_partly || 0) + (s.resolved_no || 0);
    main.replaceChildren(
      top('Needs review', 'Answers visitors disliked. Write the answer DES should have given and it will use it next time.'),
      h('div', { class: 'grid grid--kpi', style: { marginBottom: '16px' } },
        tile('Waiting for review', n(q.length)),
        tile('Average rating', s.avg_rating ? `${Number(s.avg_rating).toFixed(1)} / 5` : '—', `${n(s.surveys)} surveys · 30 days`),
        tile('Found what they needed', resolved ? `${Math.round(((s.resolved_yes || 0) / resolved) * 100)}%` : '—', resolved ? `${n(s.resolved_yes)} yes · ${n(s.resolved_partly)} partly · ${n(s.resolved_no)} no` : 'no answers yet'),
        tile('Thumbs down', n(s.thumbs_down), `${n(s.thumbs_up)} thumbs up · 30 days`)),
      s.reasons?.length ? h('section', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card__head' }, h('h2', { text: 'Why visitors disliked answers' })), h('div', { class: 'card__body' }, hbars(s.reasons.map((r) => ({ label: r.reason, n: r.n }))))) : null,
      h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('h2', { text: 'Disliked answers' })),
        q.length ? h('div', { class: 'card__body' }, q.map((r) => h('article', { class: 'qa' },
          h('div', { class: 'qa__q', text: r.question || '(question not found)' }),
          h('div', { class: 'qa__a', html: fmt(r.answer) }),
          h('div', { class: 'qa__foot' }, r.reasons?.length ? badge('👎 ' + r.reasons.join(', '), 'badge--bad') : badge('👎', 'badge--bad'), h('span', { class: 'sp' }),
            h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Write the right answer', on: { click: () => openGolden({ question: r.question || '', ideal_answer: r.answer, product: r.product || guessProduct(r.question), message_id: Number(r.message_id) }) } }),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Open chat', on: { click: () => openConversation(r.conversation_id) } })))))
          : empty('Nothing to review', 'When a visitor gives an answer a thumbs down, it shows up here.')));
  }
  function guessProduct(text) {
    const t = String(text || '').toLowerCase();
    return state.status.products.find((p) => p !== GENERAL && t.includes(p.toLowerCase())) || GENERAL;
  }

  // ---------------- website knowledge ----------------
  async function pageKb() {
    loading();
    let kb; try { kb = await api('/admin/kb'); } catch (e) { return fail(e); }
    const kinds = ['all', ...new Set(kb.docs.map((d) => d.kind || 'page'))];
    let kind = 'all', term = '';
    const tbody = h('tbody');
    const draw = () => {
      const rows = kb.docs.filter((d) => (kind === 'all' || (d.kind || 'page') === kind) && (!term || (d.title || '').toLowerCase().includes(term) || d.url.toLowerCase().includes(term)));
      tbody.replaceChildren(...(rows.length ? rows.map((d) => kbRow(d, null)) : [h('tr', null, h('td', { colspan: 6 }, empty('No pages', 'Try another filter.')))]));
    };
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Page type' }, kinds.map((k) => h('button', { type: 'button', class: k === 'all' ? 'is-on' : '', text: k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1), on: { click: (e) => { kind = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === e.currentTarget)); draw(); } } })));
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search pages…', 'aria-label': 'Search pages' });
    search.addEventListener('input', debounce(() => { term = search.value.trim().toLowerCase(); draw(); }, 150));
    const url = h('input', { class: 'input', type: 'url', placeholder: 'https://dynamiqes.com/…', 'aria-label': 'Page address', style: { width: '300px' } });
    const addBtn = h('button', { class: 'btn', type: 'submit', text: 'Read page' });
    const addForm = h('form', { class: 'filters' }, url, addBtn);
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault(); if (!url.value.trim()) return;
      addBtn.disabled = true; addBtn.textContent = 'Reading…';
      try { const r = await api('/admin/ingest', { method: 'POST', body: { url: url.value.trim() } }); toast(r.error ? 'Could not read: ' + r.error : 'Page read'); pageKb(); } catch (err) { fail(err); } finally { addBtn.disabled = false; addBtn.textContent = 'Read page'; }
    });
    const sweep = h('button', { class: 'btn', type: 'button', text: 'Re-read whole website', on: { click: async () => { if (!confirm('Re-read every page in the website sitemap? This runs in the background and only re-reads pages that changed.')) return; try { await api('/admin/ingest', { method: 'POST', body: {} }); toast('Started. Changed pages update over the next few minutes.'); } catch (e) { fail(e); } } } });
    const active = kb.docs.filter((d) => d.status === 'active').length;
    main.replaceChildren(
      top('Website knowledge', `${n(active)} of ${n(kb.docs.length)} dynamiqes.com pages are used by DES. Pause pages that are outdated; re-read pages after editing them on the website.`, sweep),
      h('section', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Add or re-read a page' }), h('p', { text: 'Only dynamiqes.com addresses.' })), addForm)),
      h('section', { class: 'card' },
        h('div', { class: 'card__head' }, h('div', { class: 'filters' }, seg, search)),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', { text: 'Page' }), h('th', { text: 'Type' }), h('th', { class: 'num', text: 'Passages' }), h('th', { text: 'Updated' }), h('th', { text: 'Used by DES' }), h('th', { text: '' }))), tbody))),
      kb.log.length ? h('section', { class: 'card', style: { marginTop: '16px' } }, h('div', { class: 'card__head' }, h('h2', { text: 'Recent reading activity' })),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, kb.log.slice(0, 20).map((l) => h('tr', null,
          h('td', { class: 'muted', text: when(l.created_at), style: { whiteSpace: 'nowrap' } }), h('td', null, badge(l.ok ? 'OK' : 'Failed', l.ok ? 'badge--good' : 'badge--bad')),
          h('td', { text: l.action || '' }), h('td', { class: 'clip', text: l.url || '' }), h('td', { class: 'muted clip', text: l.detail || '' }))))))) : null,
    );
    draw();
  }

  // ---------------- settings ----------------
  async function pageSettings() {
    loading();
    let facts, gloss, prompt; try { [facts, gloss, prompt] = await Promise.all([api('/admin/facts'), api('/admin/glossary'), api('/admin/prompt')]); } catch (e) { return fail(e); }
    const s = state.status;
    const factRow = (f = { key: '', value: '' }, isNew = false) => {
      const key = h('input', { class: 'input mono', value: f.key, placeholder: 'key_name', readOnly: !isNew, 'aria-label': 'Fact name' });
      const val = h('input', { class: 'input', value: f.value, placeholder: 'Value', 'aria-label': 'Fact value' });
      const row = h('tr', null, h('td', { style: { width: '220px' } }, key), h('td', null, val), h('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Save', on: { click: async () => { const k = key.value.trim().replace(/\s+/g, '_').toLowerCase(); if (!k || !val.value.trim()) return toast('Fill in name and value', true); try { await api('/admin/facts/' + encodeURIComponent(k), { method: 'PUT', body: { value: val.value.trim() } }); toast('Saved'); if (isNew) pageSettings(); } catch (e) { fail(e); } } } }), ' ',
        !isNew ? h('button', { class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete', on: { click: async () => { if (!confirm(`Delete the fact "${f.key}"?`)) return; try { await api('/admin/facts/' + encodeURIComponent(f.key), { method: 'DELETE' }); row.remove(); toast('Deleted'); } catch (e) { fail(e); } } } }) : null));
      return row;
    };
    const glossRow = (g = { term: '', definition: '' }, isNew = false) => {
      const term = h('input', { class: 'input', value: g.term, placeholder: 'Term', readOnly: !isNew, 'aria-label': 'Term' });
      const def = h('input', { class: 'input', value: g.definition, placeholder: 'Plain-language meaning', 'aria-label': 'Definition' });
      const row = h('tr', null, h('td', { style: { width: '160px' } }, term), h('td', null, def), h('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
        h('button', { class: 'btn btn--sm', type: 'button', text: 'Save', on: { click: async () => { if (!term.value.trim() || !def.value.trim()) return toast('Fill in term and meaning', true); try { await api('/admin/glossary/' + encodeURIComponent(term.value.trim()), { method: 'PUT', body: { definition: def.value.trim() } }); toast('Saved'); if (isNew) pageSettings(); } catch (e) { fail(e); } } } }), ' ',
        !isNew ? h('button', { class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete', on: { click: async () => { if (!confirm(`Delete "${g.term}"?`)) return; try { await api('/admin/glossary/' + encodeURIComponent(g.term), { method: 'DELETE' }); row.remove(); toast('Deleted'); } catch (e) { fail(e); } } } }) : null));
      return row;
    };
    const factBody = h('tbody', null, facts.map((f) => factRow(f)));
    const glossBody = h('tbody', null, gloss.map((g) => glossRow(g)));
    const promptTa = h('textarea', { class: 'input mono', rows: 18 }); promptTa.value = prompt.text || '';
    main.replaceChildren(
      top('Settings', 'Facts and terms DES always knows, and how it is connected.'),
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('h2', { text: 'Connection' })), h('div', { class: 'card__body' }, h('dl', { class: 'kv' },
          h('dt', { text: 'Mode' }), h('dd', { text: s.mock ? 'Mock (no AI key; canned answers)' : 'Live AI through IQGateway' }),
          h('dt', { text: 'AI model' }), h('dd', { class: 'mono', text: s.model }),
          h('dt', { text: 'Gateway' }), h('dd', { class: 'mono', text: s.gateway }),
          h('dt', { text: 'Website search' }), h('dd', { text: s.embeddings === 'voyage' ? 'Voyage AI (meaning-based)' : 'Keyword-based (offline). Voyage AI gives better results.' }),
          h('dt', { text: 'Answer matching' }), h('dd', { text: `An approved answer is used when the match score is at least ${Math.round(s.golden_min_score * 100)}% (GOLDEN_MIN_SCORE).` }),
          h('dt', { text: 'Daily AI budget' }), h('dd', { text: usd(s.daily_budget_usd) + ' (DAILY_BUDGET_USD)' }),
        ))),
        h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Company facts' }), h('p', { text: 'Sent to DES with every message. Keep them short and exact.' })),
          h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add fact', on: { click: () => { factBody.append(factRow(undefined, true)); factBody.lastElementChild.querySelector('input').focus(); } } })),
          h('div', { class: 'table-wrap' }, h('table', null, factBody))),
        h('section', { class: 'card' }, h('div', { class: 'card__head' }, h('div', null, h('h2', { text: 'Glossary' }), h('p', { text: 'When a visitor uses one of these terms, DES gets the plain-language meaning.' })),
          h('button', { class: 'btn btn--sm', type: 'button', text: '+ Add term', on: { click: () => { glossBody.append(glossRow(undefined, true)); glossBody.lastElementChild.querySelector('input').focus(); } } })),
          h('div', { class: 'table-wrap' }, h('table', null, glossBody))),
        h('details', { class: 'card' }, h('summary', { class: 'card__head', style: { cursor: 'pointer' } }, h('div', null, h('h2', { text: 'Bot instructions (advanced)' }), h('p', { text: `Version ${prompt.version || 'from file'} · persona, rules and tone. Most changes belong in approved answers or product notes instead.` }))),
          h('div', { class: 'card__body' },
            h('div', { class: 'callout', style: { marginBottom: '12px' } }, 'Saving creates a new version and DES uses it immediately. A broken edit can make every answer worse, so test a few questions in Fine-tune answers afterwards.'),
            promptTa,
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } }, h('button', { class: 'btn btn--primary', type: 'button', text: 'Save as new version', on: { click: async () => {
              if (!promptTa.value.trim()) return toast('The instructions can’t be empty', true);
              if (!confirm('Replace the bot instructions with this version?')) return;
              try { await api('/admin/prompt', { method: 'POST', body: { version: 'dashboard ' + new Date().toISOString().slice(0, 16).replace('T', ' '), text: promptTa.value } }); toast('New instructions are live'); pageSettings(); } catch (e) { fail(e); }
            } } })))),
      ),
    );
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
    if (!layer.childElementCount) return;
    layer.replaceChildren(); document.body.style.overflow = '';
    lastFocus?.focus?.({ preventScroll: true });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLayer(); });

  boot();
})();
