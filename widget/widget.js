/* DES — DynamIQ website chat widget · prototype v1 (2026-10-01)
 * Front-end only. Implements system-instruction.md §7.1 (in-chat onboarding),
 * §7.4 (survey + thumbs) and the "any issue → sales consultant" fallback.
 * The LLM is mocked (MOCK.reply). Swap `api.*` for real endpoints later.
 */
(async function () {
  'use strict';

  // ---------- config ----------
  const CFG = {
    consentVersion: '2026-10-01',
    rememberDays: 30,
    idleSurveyMs: 3 * 60 * 1000,      // 3 min (demo page can override via window.DES_CFG)
    autoOpenMs: 3000,                 // open the chat by itself 3 s after the page loads, once per browser session (0 = off)
    onboardTimeoutMs: 5 * 60 * 1000,  // no name / contact for 5 min during onboarding -> chat starts over (warning 1 min before)
    typingMs: [350, 700],
    askMarketingOptIn: true,
    privacyUrl: 'https://dynamiqes.com/privacy-policy/',
    salesEmail: 'sales@dynamiqes.com',
    salesPhone: '+63 917-630-4848',
    salesPhoneHref: 'tel:+639176304848',
    logoUrl: 'IQ_Logo.svg',
    mock: true,
    ...(window.DES_CFG || {})
  };

  // ---------- copy (EN / FIL) ----------
  const T = {
    en: {
      intro: `Happy to help with that! Before I answer, a quick formality: I'll collect your name and mobile number so our team can follow up. By continuing you agree to our <a href="${CFG.privacyUrl}" target="_blank" rel="noopener">Privacy Notice</a>.<small>We never ask for passwords, IDs or payment details.</small>`,
      agree: 'I agree ✓', readNotice: 'Read the Privacy Notice',
      notYet: "No problem — tap <b>I agree</b> when you're ready. You can also browse our <a href=\"https://dynamiqes.com/products/\" target=\"_blank\" rel=\"noopener\">Products page</a> meanwhile.",
      askName: 'Great, thanks. What\'s your full name?<small>The chat starts once I have your name and mobile number. If you leave, reload the page or don\'t reply for 5 minutes before then, it will start over.</small>',
      onboardWarn: (what) => `Still there? I just need your ${what} to continue. <b>This chat will start over in 1 minute</b> if I don't hear from you.`,
      onboardWhat: { consent: 'OK to the privacy notice', name: 'name', phone: 'mobile number', optin: 'answer on updates' },
      onboardReset: 'This chat started over because I didn\'t get your name and mobile number in time. Ask your question again whenever you\'re ready.',
      nameFirst: "I'll get to that right after — may I have your name first?",
      badName: 'Just your name, please (letters only).',
      badNameFake: "Please share your real name so our team knows who they're talking to.",
      askPhone: (n) => `Nice to meet you, ${n}. What\'s your <b>mobile number</b>, so our team can reach you? Viber or WhatsApp numbers work too.`,
      phoneFirst: 'I\'ll answer that right after. What\'s your <b>mobile number</b>?',
      badPhone: 'That doesn\'t look like a phone number. Try a mobile number like <b>0917 123 4567</b>. For numbers outside the Philippines, add the country code, e.g. <b>+65 9123 4567</b>.',
      phoneNotEmail: 'I need your <b>mobile number</b> here, not an email.',
      phoneNeedsNumber: 'Please type the <b>number</b> itself (e.g. 0917 123 4567). A Telegram, LINE or WeChat username alone isn\'t enough for our team to call you.',
      fakePhone: 'That looks like a sample or placeholder number. Please share a real number so our team can call you.',
      ownPhone: 'That\'s DynamIQ\'s own number. Please share yours so our team can reach you.',
      needPhone: `I need your mobile number before I can continue. If you'd rather not share it here, contact us directly at <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> or <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      needPhoneReturning: (n) => `Welcome back, ${n}! Before we continue, what\'s your <b>mobile number</b>, so our team can reach you?`,
      continueAs: (n, p) => `Welcome back! Continue as <b>${n}</b> · ${p}?`, itsMe: 'Yes, that\'s me', notMe: 'Not me',
      tooMany: `We've had several chats from this device or contact today. Please reach us directly at <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> or <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      phName: 'Type your full name…', phPhone: 'Mobile number…', phMsg: 'Type your message…', replying: 'DES is replying…', chatEnded: 'This chat has ended', pickOption: 'Choose an option above…', skip: 'Skip',
      until: 'until',
      endedNotice: (u) => `This chat was ended because it went off-topic${u ? `, and is paused until <b>${u}</b>` : ''}. For questions about DynamIQ, our team is at <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> or <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      optIn: 'Would you also like occasional updates on DynamIQ products and events?',
      optYes: 'Yes please', optNo: 'No thanks',
      thanksGo: (n) => `Thanks, ${n}. `,
      trouble: "Sorry — I'm having trouble with that one. Let me get a sales consultant to help you.",
      connect: 'Connect to a consultant', keep: 'Keep chatting',
      handoffDone: (c) => `Done — our team will reach you at the contact you gave within 24 hours (Mon–Fri, 8 AM–5 PM). You can also call <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> or email <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      handoffNoContact: `Our consultants are at <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> / <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a> (Mon–Fri, 8 AM–5 PM). Share a contact here and they'll call you instead.`,
      surveyIntro: "If you have a moment, I'd love to hear how this went — it helps me get better. Or choose <b>Not now</b> to keep chatting.",
      surveyQ: 'On a scale of 1 to 5, where 1 is <i>not helpful at all</i> and 5 is <i>very helpful</i>, how would you rate this chat?',
      notNow: 'Not now',
      low: "Sorry it wasn't quite right. What was missing?",
      high: 'Thank you! Anything I could do better?',
      allGood: 'No, all good',
      reasons: ["Didn't answer my question", 'Too technical', 'Too long / too much text', 'I need a human', 'Something else'],
      resolvedQ: 'Did you find out what you came for today?',
      resolved: ['Yes', 'Partly', 'No'],
      bye: (n) => `Thanks, ${n || 'and take care'}! Our team will be in touch.`,
      typeMore: 'You can type a short note, or tap an option.',
      thumbsDownQ: 'Thanks for flagging. What went wrong?',
      noted: 'Noted — thank you.',
      welcomeBack: (n) => `Welcome back, ${n}! What can I help you with today?`,
      hello: 'Hi there! 👋 I\'m DES, DynamIQ\'s assistant. Something slowing your business down? Let\'s figure it out together.',
      what: 'What can I help you with today?',
      chips: ['Book a free demo', 'Which product fits my business?', 'BIR CAS compliance', 'Talk to a consultant']
    },
    fil: {
      intro: `Sige, tutulungan kita diyan! Bago ako sumagot, kukunin ko lang ang pangalan at mobile number mo para maka-follow up ang team namin. Sa pagpapatuloy, sumasang-ayon ka sa aming <a href="${CFG.privacyUrl}" target="_blank" rel="noopener">Privacy Notice</a>.<small>Hindi kami humihingi ng password, ID o payment details.</small>`,
      agree: 'Sang-ayon ako ✓', readNotice: 'Basahin ang Privacy Notice',
      notYet: 'Walang problema — i-tap lang ang <b>Sang-ayon ako</b> kapag handa ka na.',
      askName: 'Salamat! Ano ang buong pangalan mo?<small>Magsisimula ang chat kapag nakuha ko na ang pangalan at mobile number mo. Kung aalis ka, magre-reload, o hindi sasagot nang 5 minuto bago noon, magsisimula ulit ang chat.</small>',
      onboardWarn: (what) => `Nandiyan ka pa ba? Kailangan ko lang ang ${what} mo para magpatuloy. <b>Magsisimula ulit ang chat sa loob ng 1 minuto</b> kung walang sagot.`,
      onboardWhat: { consent: 'pagsang-ayon sa privacy notice', name: 'pangalan', phone: 'mobile number', optin: 'sagot tungkol sa updates' },
      onboardReset: 'Nagsimula ulit ang chat dahil hindi ko nakuha ang pangalan at mobile number mo sa oras. Itanong mo ulit kapag handa ka na.',
      nameFirst: 'Sasagutin ko \'yan pagkatapos — pwede bang malaman muna ang pangalan mo?',
      badName: 'Pangalan mo lang po (letra lang).',
      badNameFake: 'Pakibigay po ang tunay mong pangalan para alam ng team kung sino ang kausap nila.',
      askPhone: (n) => `Ikinagagalak kitang makilala, ${n}. Ano ang <b>mobile number</b> mo para makontak ka ng team namin? Pwede rin ang Viber o WhatsApp number.`,
      phoneFirst: 'Sasagutin ko \'yan pagkatapos. Ano ang <b>mobile number</b> mo?',
      badPhone: 'Parang hindi phone number \'yan. Subukan ang mobile number gaya ng <b>0917 123 4567</b>. Kung nasa labas ng Pilipinas, isama ang country code, hal. <b>+65 9123 4567</b>.',
      phoneNotEmail: '<b>Mobile number</b> po ang kailangan ko dito, hindi email.',
      phoneNeedsNumber: 'Pakitype po ang mismong <b>number</b> (hal. 0917 123 4567). Hindi sapat ang Telegram, LINE o WeChat username para matawagan ka ng team.',
      fakePhone: 'Mukhang sample o placeholder na number \'yan. Pakibigay po ang totoong number para matawagan ka ng team.',
      ownPhone: 'Number po ng DynamIQ \'yan. Pakibigay ang sa \'yo para makontak ka ng team namin.',
      needPhone: `Kailangan ko ang mobile number mo bago tayo magpatuloy. Kung ayaw mong ibahagi dito, kontakin kami sa <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> o <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      needPhoneReturning: (n) => `Welcome back, ${n}! Bago tayo magpatuloy, ano ang <b>mobile number</b> mo para makontak ka ng team namin?`,
      continueAs: (n, p) => `Welcome back! Magpatuloy bilang <b>${n}</b> · ${p}?`, itsMe: 'Oo, ako ito', notMe: 'Hindi ako',
      tooMany: `Marami nang chat mula sa device o contact na ito ngayong araw. Kontakin kami sa <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> o <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      phName: 'I-type ang buong pangalan mo…', phPhone: 'Mobile number…', phMsg: 'Mag-type ng mensahe…', replying: 'Sumasagot si DES…', chatEnded: 'Tapos na ang chat na ito', pickOption: 'Pumili sa mga opsyon sa itaas…', skip: 'Laktawan',
      until: 'hanggang',
      endedNotice: (u) => `Tinapos ang chat na ito dahil napunta sa ibang usapan${u ? `, at naka-pause hanggang <b>${u}</b>` : ''}. Para sa tanong tungkol sa DynamIQ, nandito ang team namin: <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> o <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      optIn: 'Gusto mo rin bang makatanggap ng updates tungkol sa DynamIQ products at events?',
      optYes: 'Oo, sige', optNo: 'Hindi na',
      thanksGo: (n) => `Salamat, ${n}. `,
      trouble: 'Pasensya na — nahihirapan ako diyan. Ikokonekta kita sa isang sales consultant.',
      connect: 'Kausapin ang consultant', keep: 'Magpatuloy sa chat',
      handoffDone: () => `Sige — kokontakin ka ng team namin sa loob ng 24 oras (Lun–Biy, 8 AM–5 PM). Pwede ka ring tumawag sa <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a>.`,
      handoffNoContact: `Nandito ang consultants namin: <a href="${CFG.salesPhoneHref}">${CFG.salesPhone}</a> / <a href="mailto:${CFG.salesEmail}">${CFG.salesEmail}</a>.`,
      surveyIntro: 'Kung may oras ka, gusto kong malaman kung paano ito naging — nakakatulong ito para gumaling ako. O piliin ang <b>Hindi ngayon</b> para magpatuloy.',
      surveyQ: 'Sa scale na 1 hanggang 5, kung saan 1 ay <i>hindi nakatulong</i> at 5 ay <i>sobrang nakatulong</i>, paano mo ira-rate ang chat na ito?',
      notNow: 'Hindi ngayon',
      low: 'Pasensya na kung kulang. Ano ang nawawala?',
      high: 'Salamat! May pwede pa ba akong pagbutihin?',
      allGood: 'Wala na, okay na',
      reasons: ['Hindi nasagot ang tanong ko', 'Masyadong technical', 'Masyadong mahaba', 'Kailangan ko ng tao', 'Iba pa'],
      resolvedQ: 'Nakuha mo ba ang pinunta mo ngayon?',
      resolved: ['Oo', 'Medyo', 'Hindi'],
      bye: (n) => `Salamat, ${n || 'at ingat'}! Makikipag-ugnayan ang team namin.`,
      typeMore: 'Pwede kang mag-type ng maikling note, o pumili ng option.',
      thumbsDownQ: 'Salamat sa pag-flag. Ano ang mali?',
      noted: 'Noted — salamat.',
      welcomeBack: (n) => `Welcome back, ${n}! Ano ang maitutulong ko ngayon?`,
      hello: 'Kumusta! 👋 Ako si DES, ang assistant ng DynamIQ. May bumabagal ba sa negosyo mo? Alamin natin.',
      what: 'Ano ang maitutulong ko ngayon?',
      chips: ['Mag-book ng free demo', 'Aling product ang bagay sa akin?', 'BIR CAS compliance', 'Kausapin ang consultant']
    }
  };
  const NOTICE = `<strong>Privacy Notice — DES, DynamIQ Website Assistant</strong>DynamIQ Enterprise Solutions Inc. collects your name and mobile number (and your email address only if you give it, e.g. when booking a demo), together with the messages you send in this chat, so we can answer your inquiry and have a member of our team follow up. We process this under the Data Privacy Act of 2012 (RA 10173), its IRR and NPC issuances, based on your consent and our legitimate interest in responding to inquiries. Your details are shared only with our sales and support staff and the providers that host this chat. We keep your information for as long as needed to handle your inquiry and up to 12 months afterwards, unless the law requires longer. You may withdraw consent or ask to access, correct or delete your data by emailing our Data Protection Officer at <a href="mailto:dpo@dynamiqes.com">dpo@dynamiqes.com</a>. Please do not share passwords, financial details, TIN or other sensitive information here. <a href="${CFG.privacyUrl}" target="_blank" rel="noopener">Full Privacy Policy →</a>`;

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rnd = ([a, b]) => a + Math.random() * (b - a);
  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /** Model reply (plain text with light markdown) -> safe HTML. Escapes first, then **bold**, *italic*, bullet / numbered lists, links, paragraphs. */
  const fmt = (raw) => {
    const inline = (s) => esc(s)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)(?=[.,!?;:]?(?:[\s)]|$))/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const out = [];
    let list = null; // {tag, items}
    const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    for (const line of String(raw || '').split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
        list.items.push(inline((ul || ol)[1]));
      } else if (!line.trim()) { flush(); flushPara(); }
      else { flush(); para.push(inline(line)); }
    }
    flush(); flushPara();
    return `<div class="dq-chat__rich">${out.join('')}</div>`;
  };
  const isFil = (s) => /\b(ba|ng|mga|ako|kami|namin|natin|po|kayo|sana|paano|magkano|ano|saan|kailangan|gusto|pwede|puwede|yung|lang|salamat|kumusta|hindi|oo|sige)\b/i.test(s) && !/\b(the|and|for|with|our|we|you)\b/i.test(s.split(/\s+/).slice(0, 6).join(' '));
  const AFFIRM = /^(yes|yep|yeah|ok|okay|sure|agree|i agree|go|proceed|oo|opo|sige|sang-ayon|ayos|tara)\b/i;
  const BYE = /\b(bye|goodbye|thanks?,? (that'?s|thats) all|that'?s all|salamat,? bye|ingat|see you|ok thanks|thank you,? bye)\b/i;
  const PII = /(\d[ -]?){13,19}|\d{3}-\d{3}-\d{3}-\d{3}|\d{2}-\d{7}-\d|\d{4}-\d{4}-\d{4}/g; // cards, TIN, SSS, PhilHealth/Pag-IBIG-ish
  // ---- name + contact checks: mirror of backend/src/contact.js (the server re-checks and also verifies the email domain) ----
  const FAKE_NAME = new Set('test testing tester sample demo user admin administrator anonymous anon none na nobody name myname noname guest visitor customer client asdf asd qwerty abc abcd xyz xxx aaa unknown secret private hello hi hey bot ai chatgpt gpt des dynamiq sir maam madam mister miss ako me myself i yo person human someone somebody fake dummy null undefined'.split(' '));
  const PLATFORMS = [[/\bviber\b/i, 'viber'], [/\b(whats\s?app|wa)\b/i, 'whatsapp'], [/\b(we\s?chat|weixin)\b/i, 'wechat'], [/\b(telegram|tg)\b/i, 'telegram'], [/\bsignal\b/i, 'signal'], [/\bline\b/i, 'line']];
  const PHONE_WORDS = /\b(viber|whats\s?app|wa|we\s?chat|weixin|telegram|tg|signal|line|sms|text|call|mobile|mob|cell(phone)?|cp|phone|tel|telephone|landline|number|no|num|my|is|at|or|and|ph|philippines)\b|[#:]/gi;
  const NAME_PREFIX = /^(?:(?:hi|hello|hey|good (?:morning|afternoon|evening))[,!.\s]+)?(?:i'?m|i am|im|my name is|my name'?s|name is|name'?s|this is|it'?s|call me|ako si|ako po si|ako po|ako ay|si|ang pangalan ko ay|pangalan ko ay|pangalan ko)\s+(?=\S)/i;
  function checkName(raw) {
    const v = String(raw || '').trim().replace(/\s+/g, ' ').replace(NAME_PREFIX, '');
    if (!/^[\p{L} .'-]{2,60}$/u.test(v) || (v.match(/\p{L}/gu) || []).length < 2) return { ok: false, code: 'bad_name' };
    const low = v.toLowerCase().replace(/[.'-]/g, ''); const words = low.split(' ').filter(Boolean);
    if (FAKE_NAME.has(low) || FAKE_NAME.has(low.replace(/\s/g, '')) || words.every(w => FAKE_NAME.has(w))) return { ok: false, code: 'fake_name' };
    for (const w of words) {
      if (/^(.)\1+$/u.test(w) || (w.length >= 4 && !/[aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿ]/i.test(w)) || /[^aeiouy\s]{5,}/i.test(w.normalize('NFD').replace(/\p{M}/gu, '')) || /(.)\1{3,}/u.test(w)) return { ok: false, code: 'fake_name' };
    }
    return { ok: true, value: v.replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) };
  }
  function fakeDigits(d) {
    if (/(\d)\1{5,}/.test(d)) return true;
    let up = 1, down = 1;
    for (let i = 1; i < d.length; i++) { up = (+d[i] === (+d[i - 1] + 1) % 10) ? up + 1 : 1; down = (+d[i] === (+d[i - 1] + 9) % 10) ? down + 1 : 1; if (up >= 6 || down >= 6) return true; }
    if (/^(\d{2})\1{3,}/.test(d.slice(-8)) || /^(\d{3})\1{2,}/.test(d.slice(-9))) return true;
    return new Set(d.slice(-7)).size <= 2;
  }
  /** Required mobile number (any label: Viber, WhatsApp…). A username alone doesn't count. */
  function checkPhone(raw) {
    const s0 = String(raw || '').trim();
    if (!s0) return { ok: false, code: 'phone_required' };
    const platform = (PLATFORMS.find(([re]) => re.test(s0)) || [])[1] || null;
    if (platform && (s0.match(/\d/g) || []).length < 7) return { ok: false, code: 'phone_needs_number' };
    if (!platform && s0.includes('@') && (s0.match(/\d/g) || []).length < 7) return { ok: false, code: 'phone_not_email' };
    const st = s0.replace(PHONE_WORDS, ' ').replace(/[\s().\-–/]/g, '');
    if (!/^\+?\d+$/.test(st)) return { ok: false, code: 'bad_phone' };
    let d = st.replace(/^\+/, ''); const intl = st.startsWith('+') || st.startsWith('00'); if (st.startsWith('00')) d = d.slice(2);
    let value, type;
    if (/^(63|0)?9\d{9}$/.test(d)) { value = '+63' + d.slice(-10); type = platform || 'mobile'; }
    else if (!intl && /^0[2-8]\d{7,8}$/.test(d)) { value = '+63' + d.slice(1); type = 'landline'; }
    else if (/^63[2-8]\d{7,8}$/.test(d)) { value = '+' + d; type = 'landline'; }
    else if (intl && /^[1-9]\d{7,14}$/.test(d)) { value = '+' + d; type = platform || 'mobile'; }
    else return { ok: false, code: 'bad_phone' };
    if (fakeDigits(value.replace(/^\+(63)?/, ''))) return { ok: false, code: 'fake_phone' };
    const own = String(CFG.salesPhone || '').replace(/\D/g, '').replace(/^0/, '63').replace(/^63/, '');
    if (own.length > 6 && value.replace(/\D/g, '').endsWith(own)) return { ok: false, code: 'own_phone' };
    return { ok: true, value, type };
  }
  // server / widget error code -> copy key
  const PHONE_MSG = { phone_required: 'badPhone', bad_phone: 'badPhone', phone_not_email: 'phoneNotEmail', phone_needs_number: 'phoneNeedsNumber', fake_phone: 'fakePhone', own_phone: 'ownPhone' };
  /** +639171234567 -> 0917•••4567 (shown on "Continue as…") */
  const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); const local = d.startsWith('63') ? '0' + d.slice(2) : '+' + d; return local.slice(0, 4) + '•••' + local.slice(-4); };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem('des:' + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('des:' + k, JSON.stringify(v)); } catch { } },
    del(k) { try { localStorage.removeItem('des:' + k); } catch { } }
  };

  // ---------- data capture (what the backend would receive) ----------
  const data = { visitor: null, conversation: { id: 'c_' + Math.random().toString(36).slice(2, 9), lang: 'en', started_at: new Date().toISOString(), messages: [] }, lead: null, feedback: [], handoffs: [], events: [] };
  const emit = (type, payload) => { data.events.push({ type, at: new Date().toISOString(), ...payload }); window.dispatchEvent(new CustomEvent('des:data', { detail: data })); };
  // ---------- API: real backend when CFG.apiBase is set (?api=... or DES_CFG.apiBase); mock otherwise ----------
  // Backend: DES_CFG.apiBase / data-api, or ?api=…; when the page is served by the backend itself (/widget/…), use it automatically.
  // ?api=mock forces the offline demo (keyword answers, nothing saved).
  const apiParam = new URLSearchParams(location.search).get('api');
  const apiBase = apiParam === 'mock' ? '' : (CFG.apiBase || apiParam || (/^https?:$/.test(location.protocol) && location.pathname.startsWith('/widget/') ? location.origin + '/api' : ''));
  let token = store.get('token', null);
  // random per-device id so a ban after an ended chat follows the device, not just the contact
  let deviceId = store.get('device', null);
  if (!deviceId) { deviceId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).toLowerCase(); store.set('device', deviceId); }
  const http = async (path, body, { stream = false, signal } = {}) => {
    const r = await fetch(apiBase + path, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-des-device': deviceId, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
    if (!r.ok) {
      const e = new Error('api ' + r.status); try { e.body = await r.json(); } catch { }
      if (r.status === 401 && e.body?.error === 'phone_required') e.phoneRequired = true; // signed up before mobile numbers were required: ask for one, keep the session
      else if (r.status === 401 && path !== '/session') { token = null; store.del('token'); e.sessionGone = true; } // expired or unknown session
      throw e;
    }
    return stream ? r : r.json();
  };
  /** Parse an SSE stream into {text, chips, handoff, handoffOffer, blocked} while calling onDelta. */
  async function readSSE(res, onDelta, onEvent) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '', final = null, err = null;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1]; const d = (block.match(/^data: (.*)$/m) || [])[1]; if (!ev || !d) continue;
        const j = JSON.parse(d);
        if (ev === 'text') { text += j.delta; onDelta?.(j.delta); }
        else if (ev === 'event') onEvent?.(j);
        else if (ev === 'replace') { text = j.text; onDelta?.(null, j.text); }
        else if (ev === 'done') final = j;
        else if (ev === 'error') err = j;
      }
    }
    if (err) throw Object.assign(new Error(err.code), { code: err.code });
    return { text: final?.text ?? text, blocked: final?.blocked || null, sources: final?.sources || [], handoffOffer: final?.blocked === 'trouble', message_id: final?.message_id ?? null, ended: !!final?.ended, until: final?.until || null };
  }
  const mockApi = {
    async session(v) { emit('session.create', { visitor: v }); return { session_id: 's_' + Date.now() }; },
    async chat(msg) { return MOCK.reply(msg, data); },
    async saveLead(l) { data.lead = { ...(data.lead || {}), ...l, updated_at: new Date().toISOString() }; emit('lead.save', { lead: data.lead }); },
    async handoff(reason) { const h = { reason, at: new Date().toISOString(), phone: data.visitor?.phone || null }; data.handoffs.push(h); emit('handoff', h); },
    async feedback(f) { data.feedback.push({ ...f, at: new Date().toISOString() }); emit('feedback', f); },
    async end() { }
  };
  const realApi = {
    async session(v) {
      const transcript = outbox.slice(0, 40);
      const j = await http('/session', { name: v.name, phone: v.phone, phone_type: v.phone_type, consent: v.consent, marketing_opt_in: v.marketing_opt_in, lang: S.lang, page_url: location.href, turnstile: window.__turnstileToken || null, transcript });
      outbox.length = 0; // stored with the session (anything past 40 bubbles is dropped)
      token = j.token; store.set('token', token); data.conversation.id = j.session_id; emit('session.create', { visitor: v, session_id: j.session_id }); return j;
    },
    async resume() {
      try { const j = await http('/session/resume', { lang: S.lang }); token = j.token; store.set('token', token); data.conversation.id = j.session_id; return true; }
      catch (e) { if (e.phoneRequired) return 'phone'; token = null; store.del('token'); return false; }
    },
    async addPhone(p) { return http('/session/phone', { phone: p.value, phone_type: p.type }); },
    async chat(msg, { held, prefix, signal } = {}) {
      await flushLog();
      const res = await http('/chat', { message: msg, ...(held ? { held: true, prefix } : {}) }, { stream: true, signal });
      const out = await readSSE(res, null, (ev) => { if (ev.type === 'lead') { data.lead = { ...(data.lead || {}), product_interest: ev.product_interest }; emit('lead.save', { lead: data.lead }); } if (ev.type === 'handoff') { data.handoffs.push({ reason: ev.reason, at: new Date().toISOString() }); emit('handoff', ev); } });
      return { ended: out.ended, until: out.until, message_id: out.message_id, text: fmt(out.text), handoffOffer: out.blocked === 'trouble' || out.blocked?.includes?.('claim'), blocked: out.blocked };
    },
    async saveLead() { },
    async handoff(reason) { await flushLog(); await http('/handoff', { reason }); data.handoffs.push({ reason, at: new Date().toISOString() }); emit('handoff', { reason }); },
    async feedback(f) { await http('/feedback', f); data.feedback.push({ ...f, at: new Date().toISOString() }); emit('feedback', f); },
    async end() { try { await flushLog(); await http('/end', {}); } catch { } }
  };
  const api = apiBase ? realApi : mockApi;

  // ---------- conversation log ----------
  // Every bubble the visitor sees and every message or choice they send must reach the dashboard. AI questions and
  // answers are stored by the server; everything else (greeting, sign-up, survey, notices) is queued here and sent
  // with POST /session (what happened before sign-up), then via /log. Nothing is stored before sign-up finishes.
  const outbox = [];
  let flushing = Promise.resolve(), flushTimer = null;
  function logItem(role, content, extra) {
    if (!apiBase || !content) return;
    outbox.push({ role, content: String(content).slice(0, 1000), ...(extra || {}) });
    if (outbox.length > 60) outbox.splice(1, 1); // before sign-up: keep the first (held) question
    clearTimeout(flushTimer); flushTimer = setTimeout(() => { flushLog(); }, 400);
  }
  function flushLog() {
    flushing = flushing.then(async () => {
      while (token && outbox.length) {
        const items = outbox.slice(0, 20);
        try { await http('/log', { items }); } catch (e) { if (e.sessionGone) outbox.length = 0; return; } // otherwise retry on the next flush
        outbox.splice(0, items.length);
      }
    });
    return flushing;
  }
  // page closing: the last bubbles go with sendBeacon (text/plain, so no CORS pre-check; the token rides in the body)
  window.addEventListener('pagehide', () => {
    if (!apiBase || !token || !outbox.length || !navigator.sendBeacon) return;
    navigator.sendBeacon(apiBase + '/log', new Blob([JSON.stringify({ token, items: outbox.splice(0, 20) })], { type: 'text/plain' }));
  });

  // ---------- mock "LLM" (keyword KB, layman's terms) ----------
  const MOCK = {
    reply(msg, d) {
      const q = msg.toLowerCase();
      const n = d.visitor?.first || '';
      const lead = (p, need) => api.saveLead({ product_interest: p, need });
      if (/\/fail/.test(q)) return Promise.reject(new Error('simulated LLM error'));
      if (/price|pricing|cost|magkano|how much|rate card|quote/.test(q)) { lead(['SAP Business One'], 'asked about pricing'); return Promise.resolve({ text: "I can't give pricing here — every setup is scoped to the business (users, cloud or on-site, which modules, add-ons). The quickest way is a free business analysis: our consultant looks at how you work now and sends a tailored proposal within 24 hours.<p>Want me to line that up?</p>", chips: ['Yes, book a free business analysis', 'Tell me more first'], handoffHint: true }); }
      if (/bir|cas|tax|ebir|alphalist|2550|2307/.test(q)) { lead(['IQ Tax', 'SAP Business One'], 'BIR CAS / tax compliance'); return Promise.resolve({ text: "Yes — this is one of the things we do most.<p>In plain terms: a <b>CAS</b> (Computerized Accounting System) is just the BIR's name for accounting software whose books and forms they've checked and approved. Large taxpayers are required to have one; many smaller companies register too so they can issue e-invoices.</p><p>Our <b>IQ Tax</b> add-on sits inside SAP Business One and fills BIR forms (2550Q, 1601-EQ, 2307…) straight from your books — no re-typing into eBIRForms. We also walk you through the BIR application, including the mock demo.</p><p>Has the BIR already tagged you as a large taxpayer, or are you preparing ahead?</p>", chips: ['BIR already notified us', 'Preparing ahead', 'Talk to a consultant'] }); }
      if (/payroll|hr|sss|philhealth|pag-?ibig|timekeeping|attendance|employee/.test(q)) { lead(['IQ People'], 'HR / payroll'); return Promise.resolve({ text: "That's <b>IQ People</b> — our HR and payroll system built for the Philippines.<p>Think of it as one place for your 201 files, time-in/time-out (even by phone with GPS), leave, and payroll. It computes SSS, PhilHealth, Pag-IBIG and tax, and produces the BIR alphalist and bank payroll file. Employees get payslips and file leave from an app, so HR stops answering the same questions.</p><p>Roughly how many employees are you running payroll for?</p>", chips: ['Under 50', '50–200', 'Over 200'] }); }
      if (/ecom|e-commerce|online store|shopee|lazada|tiktok|website orders/.test(q)) { lead(['IQ Ecom', 'IQ Link'], 'e-commerce / marketplaces'); return Promise.resolve({ text: "Two options, depending on what you sell online:<ul><li><b>IQ Ecom</b> — your own B2B/B2C online store that's wired to SAP Business One. Dealers log in and see <i>their</i> agreed prices; orders drop straight into SAP, no re-encoding.</li><li><b>IQ Link</b> — the \"translator\" that syncs Shopee, Lazada and TikTok Shop orders and stock with SAP.</li></ul><p>Are you selling mostly to resellers/dealers, or to the public on marketplaces?</p>", chips: ['Resellers / dealers', 'Marketplaces', 'Both'] }); }
      if (/barcode|scan|warehouse|inventory count|stock count/.test(q)) { lead(['IQ Barcode'], 'warehouse / barcode'); return Promise.resolve({ text: "<b>IQ Barcode</b> puts a scanner (a Zebra gun or just an Android phone) in your warehouse staff's hands. Receiving, picking, transfers and stock counts are scanned instead of written down, and SAP Business One updates in real time — so the stock on the report is the stock on the shelf. Works with batch and expiry tracking too (food, pharma).<p>Typical setup is 2–4 weeks. How many warehouses or branches hold stock?</p>", chips: ['One location', 'Several branches', 'Talk to a consultant'] }); }
      if (/integrat|connect|pos|sync|link|api/.test(q)) { lead(['IQ Link'], 'integration'); return Promise.resolve({ text: "<b>IQ Link</b> is our connector. If your POS, bank, e-commerce or another system needs to \"talk\" to SAP Business One, IQ Link moves the data on a schedule or in real time, checks it, and shows a status report if anything doesn't match. No per-transaction fees.<p>Which system are you hoping to connect?</p>", chips: ['POS', 'E-commerce', 'Another ERP / database'] }); }
      if (/sap|erp|accounting system|quickbooks|peachtree|excel|spreadsheet|which product|fit|recommend|aling product/.test(q)) { lead(['SAP Business One'], 'ERP / core system'); return Promise.resolve({ text: "<b>SAP Business One</b> is the core. The simplest way to picture it: one ledger that your sales, warehouse, purchasing and accounting all write in at the same time — so nobody re-encodes, and the owner sees real numbers today, not at month-end. It's built for small and mid-size companies, runs in the cloud or on your own server, and is BIR CAS-ready.<p>Most clients go live in 3–6 months. What are you using today — Excel, QuickBooks, or another system?</p>", chips: ['Excel / manual', 'QuickBooks / Peachtree', 'Another ERP'] }); }
      if (/demo|analysis|book|schedule|consult|talk to|agent|human|kausapin/.test(q)) { lead(null, 'requested demo / consultant'); return Promise.resolve({ handoff: 'visitor', text: n ? `Great, ${n}. ` : '' }); }
      if (/job|career|hiring|apply|resume|cv|work for/.test(q)) return Promise.resolve({ text: `We're hiring SAP Business One consultants, helpdesk and sales roles in Metro Manila and Cebu. Send your CV and the position to <a href="mailto:hr@dynamiqes.com">hr@dynamiqes.com</a> or call +63 917 703 2701. Openings: <a href="https://dynamiqes.com/career/" target="_blank" rel="noopener">dynamiqes.com/career</a>.` });
      if (/who are you|what is dynamiq|about/.test(q)) return Promise.resolve({ text: "DynamIQ is a Filipino IT consultancy and SAP Premier Partner based in Quezon City. We implement SAP Business One for small and mid-size companies and build the IQ Suite of add-ons around it — tax, HR, e-commerce, barcoding, integration and more. Clients include MacroAsia, Presline Steel and Bridgestone's PH distributor.<p>What does your business do?</p>" });
      // unknown → default to human
      return Promise.resolve({ text: "I'm not sure I have a good answer for that one, and I'd rather not guess.", handoffOffer: true });
    }
  };

  // ---------- DOM ----------
  const root = $('#dq-chat'); if (!root) return;
  const toggle = $('#dqChatToggle', root);
  const body = $('.dq-chat__body', root);
  const input = $('.dq-chat__composer input', root);
  const sendBtn = $('.dq-chat__send', root);
  const note = $('.dq-chat__note', root);
  const closeLbl = $('.dq-chat__close', root);
  const statusEl = $('.dq-chat__status', root);
  const head = $('.dq-chat__head', root);

  // header menu
  const menu = el('div', 'dq-chat__menu', `<button type="button" aria-label="Menu" aria-haspopup="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button><ul role="menu"><li><button type="button" data-act="handoff">Connect to a consultant</button></li><li><button type="button" data-act="notice">Privacy Notice</button></li><li><button type="button" data-act="reset">Not you? Start over</button></li></ul>`);
  head.insertBefore(menu, closeLbl);
  menu.querySelector(':scope > button').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('is-open'); });
  document.addEventListener('click', () => menu.classList.remove('is-open'));
  menu.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { menu.classList.remove('is-open'); ({ handoff: () => handoff('visitor'), notice: () => showNotice(), reset: () => reset() })[b.dataset.act](); }));

  input.disabled = false; sendBtn.disabled = false;
  input.placeholder = 'Type your message…';
  function updatePlaceholder() {
    if (S.busy || S.awaitChoice) return;
    const ph = S.step === 'phone' || S.step === 'phone_only';
    input.placeholder = S.step === 'name' ? S.t.phName : ph ? S.t.phPhone : S.t.phMsg;
    input.setAttribute('inputmode', ph ? 'tel' : 'text');
    input.setAttribute('autocomplete', S.step === 'name' ? 'name' : ph ? 'tel' : 'off');
  }
  /** DES ended the chat (repeated off-topic / abuse): keep the composer locked. "Not you? Start over" resets. */
  function untilText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(S.lang === 'fil' ? 'fil-PH' : 'en-PH', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function endChat(until) {
    const u = until || store.get('endedUntil', null) || new Date(Date.now() + 24 * 3600e3).toISOString();
    store.set('endedUntil', u);
    S.ended = true; S.busy = false; S.awaitChoice = false; input.disabled = true; sendBtn.disabled = true;
    input.placeholder = S.t.chatEnded + (untilText(u) ? ` · ${S.t.until} ${untilText(u)}` : '');
    root.classList.remove('is-busy'); root.classList.add('is-ended');
    emit('ended', { until: u });
  }
  const banActive = () => { const u = store.get('endedUntil', null); return u && new Date(u).getTime() > Date.now() ? u : null; };
  /** Lock the text box and send button while DES is thinking / replying. */
  function setBusy(on) {
    if (S.ended) return endChat();
    S.busy = on;
    if (on) input.setAttribute('aria-busy', 'true'); else input.removeAttribute('aria-busy');
    applyComposer();
    if (!on && !S.awaitChoice && toggle && toggle.checked) input.focus();
  }
  /** Text box is locked while DES replies (busy), while a required choice is on screen (awaitChoice), or after the chat ended. */
  function applyComposer() {
    if (S.ended) return;
    const locked = !!(S.busy || S.awaitChoice);
    input.disabled = locked; sendBtn.disabled = locked;
    root.classList.toggle('is-busy', !!S.busy);
    root.classList.toggle('is-choosing', !!S.awaitChoice && !S.busy);
    if (S.busy) input.placeholder = S.t.replying;
    else if (S.awaitChoice) input.placeholder = S.t.pickOption;
    else updatePlaceholder();
  }
  function lockForChoice() { S.awaitChoice = true; applyComposer(); }
  function unlockChoice() { S.awaitChoice = false; applyComposer(); if (!S.busy && !S.ended && toggle && toggle.checked) setTimeout(() => input.focus(), 50); }
  note.innerHTML = `By chatting you agree to our <a href="${CFG.privacyUrl}" target="_blank" rel="noopener">Privacy Notice</a>`;
  body.innerHTML = ''; // drop the static mockup thread
  body.append(el('p', 'dq-chat__day', 'Today'));

  // ---------- state ----------
  const S = { step: 'idle', held: null, lang: 'en', t: T.en, botAnswers: 0, surveyDone: false, surveyOpen: false, downStreak: 0, idleTimer: null, busy: false, pending: null, phoneTries: 0, tmpName: null };

  function setLang(l) { S.lang = l; S.t = T[l]; data.conversation.lang = l; }
  function setStatus() {
    if (data.visitor) { statusEl.className = 'dq-chat__status is-named'; statusEl.innerHTML = `<i aria-hidden="true"></i>Chatting as ${esc(data.visitor.first)} · <button type="button">Not you?</button>`; statusEl.querySelector('button').onclick = reset; }
    else { statusEl.className = 'dq-chat__status'; statusEl.innerHTML = '<i aria-hidden="true"></i>Online · replies in minutes'; }
    if (!apiBase) statusEl.insertAdjacentHTML('beforeend', ' · <b title="Not connected to the DES backend: answers are canned and nothing is saved.">Demo mode</b>');
  }

  // ---------- rendering ----------
  const mini = () => `<span class="dq-chat__mini"><img src="${CFG.logoUrl}" alt="" width="16" height="16"></span>`;
  function scroll() { body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }); }
  /** log: false when the server stores it (sent to /chat); a string logs a stand-in instead (contact details). */
  function addUser(text, { log = true, held = false } = {}) {
    const m = el('div', 'dq-chat__msg is-user', `<div class="dq-chat__bubble">${esc(text)}<time>${now()}</time></div>`);
    body.append(m); scroll(); data.conversation.messages.push({ role: 'user', text, at: new Date().toISOString() });
    if (log) logItem('user', typeof log === 'string' ? log : text, held ? { held: true } : null);
    return m;
  }
  function addSystem(text) { body.append(el('div', 'dq-chat__msg is-system', `<div class="dq-chat__bubble">${text}</div>`)); scroll(); }
  let typingEl = null;
  async function typing(on) {
    if (on && !typingEl) { typingEl = el('div', 'dq-chat__msg is-bot is-typing', `${mini()}<div class="dq-chat__bubble"><span></span><span></span><span></span></div>`); body.append(typingEl); scroll(); await sleep(rnd(CFG.typingMs)); }
    if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }
  /** bot bubble. opts: {chips:[{label,cls,on,keepLock}], chipsCls, lock, notice, time, feedback:bool, id}
   *  lock: a required choice — the text box stays locked until one of these buttons is picked (keepLock buttons don't unlock). */
  async function addBot(html, opts = {}) {
    await typing(true); await typing(false);
    const m = el('div', 'dq-chat__msg is-bot');
    const b = el('div', 'dq-chat__bubble' + (opts.notice ? ' is-notice' : ''), html);
    if (opts.time !== false && !opts.chips) b.append(el('time', null, now()));
    if (opts.chips) {
      const c = el('div', 'dq-chat__chips' + (opts.chipsCls ? ' ' + opts.chipsCls : ''));
      c.setAttribute('aria-label', 'Options');
      // a tapped choice is something the visitor sent; chips that send their label as a message are logged by send()
      opts.chips.forEach(ch => { const bt = el('button', ch.cls || null, ch.label); bt.type = 'button'; bt.onclick = () => { if (c.classList.contains('is-done')) return; c.classList.add('is-done'); bt.classList.add('is-picked'); if (opts.lock && !ch.keepLock) unlockChoice(); if (!ch.sends) logItem('user', '[' + bt.textContent.trim() + ']'); ch.on && ch.on(ch.label, bt); }; c.append(bt); });
      b.append(c);
    }
    m.innerHTML = mini(); m.append(b);
    if (opts.feedback) attachThumbs(m, b, opts.id);
    body.append(m); scroll();
    if (opts.lock && opts.chips) lockForChoice();
    data.conversation.messages.push({ role: 'assistant', id: opts.id || null, text: b.textContent.trim(), at: new Date().toISOString(), scripted: !opts.feedback });
    if (!opts.serverStored) logItem('assistant', b.textContent.replace(/\s+/g, ' ').trim());
    return m;
  }
  function attachThumbs(m, bubble, id) {
    const fb = el('div', 'dq-chat__fb', `<button type="button" aria-label="Helpful">👍</button><button type="button" aria-label="Not helpful">👎</button>`);
    const [up, down] = fb.querySelectorAll('button');
    up.onclick = () => { if (up.classList.contains('is-on')) return; up.classList.add('is-on'); down.classList.remove('is-on'); fb.classList.add('is-set'); S.downStreak = 0; api.feedback({ kind: 'thumb', message_id: id, thumb: 1 }); };
    down.onclick = async () => { if (down.classList.contains('is-on')) return; down.classList.add('is-on'); up.classList.remove('is-on'); fb.classList.add('is-set'); S.downStreak++; api.feedback({ kind: 'thumb', message_id: id, thumb: -1 }); if (S.downStreak >= 2) { S.downStreak = 0; return trouble('two thumbs down'); } await askReasons(id); };
    bubble.append(fb);
  }

  // ---------- onboarding (scripted, no LLM) ----------
  // No name / contact within CFG.onboardTimeoutMs -> warn 1 min before, then start over (and say so).
  const ONBOARD_STEPS = ['consent', 'name', 'phone', 'optin'];
  function clearOnboardTimer() { clearTimeout(S.obWarn); clearTimeout(S.obReset); }
  function armOnboardTimer() {
    clearOnboardTimer();
    if (!ONBOARD_STEPS.includes(S.step) || S.ended) return;
    const step = S.step;
    S.obWarn = setTimeout(() => { if (S.step === step && !S.busy) addBot(S.t.onboardWarn(S.t.onboardWhat[step] || S.t.onboardWhat.phone), { time: false }); }, Math.max(0, CFG.onboardTimeoutMs - Math.min(60000, CFG.onboardTimeoutMs * 0.2)));
    S.obReset = setTimeout(() => { if (ONBOARD_STEPS.includes(S.step) && !S.busy) { emit('onboard.timeout', { step: S.step }); reset({ notice: S.t.onboardReset }); } }, CFG.onboardTimeoutMs);
  }
  async function startOnboarding(firstMsg) {
    S.held = firstMsg; S.step = 'consent'; armOnboardTimer();
    const t = S.t;
    await addBot(t.intro, { lock: true, chips: [{ label: t.agree, cls: 'is-primary', on: consentGiven }, { label: t.readNotice, cls: 'is-quiet', keepLock: true, on: async (_, bt) => { bt.closest('.dq-chat__chips').classList.remove('is-done'); bt.classList.remove('is-picked'); await showNotice(); } }] });
  }
  async function showNotice() { await addBot(NOTICE, { notice: true, time: false }); if (S.step === 'consent') await addBot(`${S.t.notYet}`, { lock: true, chips: [{ label: S.t.agree, cls: 'is-primary', on: consentGiven }] }); }
  async function consentGiven(method) {
    if (S.step !== 'consent') return;
    S.consent = { at: new Date().toISOString(), version: CFG.consentVersion, method: /^typed:/.test(method || '') ? method : 'chip', lang: S.lang };
    emit('consent', S.consent);
    S.step = 'name'; updatePlaceholder(); armOnboardTimer(); await addBot(S.t.askName);
  }
  async function onboardingInput(text) {
    const t = S.t;
    armOnboardTimer(); // any reply restarts the 5-minute window
    if (S.step === 'consent') { if (AFFIRM.test(text.trim())) return consentGiven('typed:' + text.trim().toLowerCase()); return addBot(t.notYet, { lock: true, chips: [{ label: t.agree, cls: 'is-primary', on: consentGiven }] }); }
    if (S.step === 'name') {
      const v = text.trim();
      if (isQuestion(v)) { holdToo(v); return addBot(t.nameFirst); }
      const nm = checkName(v);
      if (!nm.ok) return addBot(nm.code === 'fake_name' ? t.badNameFake : t.badName);
      S.tmpName = nm.value;
      S.step = 'phone'; updatePlaceholder(); return addBot(t.askPhone(esc(S.tmpName.split(' ')[0])));
    }
    if (S.step === 'phone' || S.step === 'phone_only') {
      const p = checkPhone(text);
      if (!p.ok && p.code === 'bad_phone' && isQuestion(text)) { holdToo(text); return addBot(t.phoneFirst); } // a question, not a number: hold it
      if (!p.ok) return phoneProblem(p.code);
      return S.step === 'phone_only' ? returningPhone(p) : finishOnboarding(p);
    }
    if (S.step === 'optin') return finishOptIn(false); // free text = skip
  }
  /** A question typed instead of the name / number: answered together with the held one after sign-up. */
  const isQuestion = (v) => /\?|\b(how|what|which|can|does|do you|magkano|paano|ano|saan|pwede|price)\b/i.test(v) && v.trim().split(/\s+/).length > 3;
  const holdToo = (v) => { S.held = S.held ? `${S.held}\n${v}` : v; };
  /** Bad number: explain, and after every 3 tries point to direct contact details. There is no way to skip. */
  async function phoneProblem(code) {
    const t = S.t; S.phoneTries++;
    await addBot(t[PHONE_MSG[code] || 'badPhone']);
    if (S.phoneTries >= 3 && S.phoneTries % 3 === 0) await addBot(t.needPhone, { time: false });
  }
  /** Visitor from before mobile numbers were required: add one, then carry on with the same session. */
  async function returningPhone(p) {
    setBusy(true);
    try { await api.addPhone(p); }
    catch (e) { setBusy(false); const code = e.body?.error || ''; if (code === 'chat_ended') { await addBot(S.t.endedNotice(untilText(e.body?.until))); return endChat(e.body?.until); } return phoneProblem(PHONE_MSG[code] ? code : 'bad_phone'); }
    Object.assign(data.visitor, { phone: p.value, phone_type: p.type }); store.set('visitor', { ...data.visitor, saved_at: Date.now() });
    await realApi.resume();
    S.step = 'done'; setStatus(); setBusy(false);
    const held = S.held; S.held = null;
    if (held) return answer(held, S.t.thanksGo(esc(data.visitor.first)), true);
    return addBot(S.t.what, { chips: S.t.chips.map(l => ({ label: l, sends: true, on: (lab) => send(lab) })) });
  }
  async function finishOnboarding(p) {
    if (S.step !== 'phone') return;
    const parts = S.tmpName.split(' ');
    data.visitor = { name: S.tmpName, first: parts[0], last: parts.slice(1).join(' ') || null, phone: p.value, phone_type: p.type, consent: S.consent, marketing_opt_in: false, page_url: location.href, created_at: new Date().toISOString() };
    if (CFG.askMarketingOptIn) { S.step = 'optin'; armOnboardTimer(); return addBot(S.t.optIn, { lock: true, chips: [{ label: S.t.optYes, cls: 'is-primary', on: () => finishOptIn(true) }, { label: S.t.optNo, cls: 'is-quiet', on: () => finishOptIn(false) }], chipsCls: 'is-inline' }); }
    return finishOptIn(false);
  }
  async function finishOptIn(yes) {
    if (!data.visitor || !data.visitor.phone) { S.step = 'phone'; updatePlaceholder(); return phoneProblem('phone_required'); }
    data.visitor.marketing_opt_in = !!yes;
    clearOnboardTimer();
    setBusy(true);
    let j;
    try { j = await api.session(data.visitor); }
    catch (e) {
      setBusy(false);
      const code = e.body?.error || '';
      if (code === 'bad_name' || code === 'fake_name') { data.visitor = null; S.step = 'name'; updatePlaceholder(); return addBot(code === 'fake_name' ? S.t.badNameFake : S.t.badName); }
      if (PHONE_MSG[code]) { data.visitor = null; S.step = 'phone'; updatePlaceholder(); return phoneProblem(code); }
      if (code === 'too_many_sessions') { data.visitor = null; return addBot(S.t.tooMany); }
      if (code === 'chat_ended') { data.visitor = null; await addBot(S.t.endedNotice(untilText(e.body?.until))); return endChat(e.body?.until); }
      emit('error', { message: 'session: ' + (code || e.message) });
      data.visitor = null; S.step = 'phone'; updatePlaceholder();
      return addBot(S.t.trouble, { chips: [{ label: S.t.connect, cls: 'is-primary', on: () => handoff('system', 'session failed: ' + (code || e.message)) }] });
    }
    if (j && j.phone) Object.assign(data.visitor, { name: j.name || data.visitor.name, first: j.first_name || data.visitor.first, last: j.last_name ?? data.visitor.last, phone: j.phone, phone_type: j.phone_type });
    S.step = 'done';
    store.set('visitor', { ...data.visitor, saved_at: Date.now() });
    setStatus();
    const held = S.held; S.held = null;
    if (held) await answer(held, S.t.thanksGo(esc(data.visitor.first)), true); // stays locked straight into the answer
    else setBusy(false);
  }


  // ---------- main answer path ----------
  async function answer(text, prefix = '', held = false) {
    setBusy(true);
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      // after 20 s give up and cancel the request, so the server records the reply as not delivered
      const r = await Promise.race([api.chat(text, { held, prefix, signal: ac?.signal }), sleep(20000).then(() => { ac?.abort(); throw new Error('timeout'); })]);
      S.botAnswers++;
      if (r.handoff) { await addBot((prefix || r.text || '') + (S.lang === 'fil' ? 'Ikokonekta kita sa isang sales consultant.' : "I'll connect you with one of our sales consultants."), { time: false }); return handoff(r.handoff); }
      const id = r.message_id ?? ('m_' + Date.now()); // numeric id from the server links thumbs to this reply
      const chips = (r.chips || []).map(l => ({ label: l, sends: true, on: (lab) => send(lab) }));
      if (r.handoffOffer) chips.push({ label: S.t.connect, cls: 'is-primary', on: () => handoff('model') });
      if (r.ended) { await addBot(prefix + r.text, { time: true, serverStored: !!apiBase }); return endChat(r.until); }
      await addBot(prefix + r.text, { chips: chips.length ? chips : null, feedback: !r.blocked, id, serverStored: !!apiBase });
      if (chips.length) body.lastElementChild.querySelector('.dq-chat__bubble').append(el('time', null, now()));
      armIdle();
    } catch (e) {
      emit('error', { message: String(e.message || e) });
      if (e.phoneRequired) { setBusy(false); S.held = text; return askReturningPhone(); }
      if (e.sessionGone) { // session expired or no longer on the server: start over instead of showing an error
        setBusy(false);
        return reset({ notice: S.lang === 'fil' ? 'Nag-expire na ang session mo. Magsimula tayo ulit.' : 'Your chat session expired. Let\'s start again.' });
      }
      await trouble('system: ' + (e.message || e));
    }
    finally { setBusy(false); input.focus(); }
  }
  async function trouble(reason) {
    await addBot(S.t.trouble, { lock: true, chips: [{ label: S.t.connect, cls: 'is-primary', on: () => handoff('system', reason) }, { label: S.t.keep, cls: 'is-quiet', on: () => { } }] });
  }
  async function handoff(kind, reason) {
    await api.handoff(reason ? `${kind}: ${reason}` : kind);
    await addBot(data.visitor?.phone ? S.t.handoffDone(data.visitor.phone) : S.t.handoffNoContact);
    if (!S.surveyDone) { await sleep(600); survey('handoff'); }
  }

  // ---------- survey ----------
  async function survey(trigger) {
    if (S.surveyDone || S.surveyOpen) return;
    S.surveyOpen = true; clearTimeout(S.idleTimer); emit('survey.open', { trigger });
    const t = S.t, fb = { kind: 'survey', trigger };
    await addBot(t.surveyIntro, { time: false });
    await addBot(t.surveyQ, { lock: true, chipsCls: 'is-rating', chips: [1, 2, 3, 4, 5].map(n => ({ label: String(n), on: () => rated(n) })) });
    const tail = await addBot('', { time: false, lock: true, chips: [{ label: t.notNow, cls: 'is-quiet', on: () => { S.surveyOpen = false; S.surveyDone = true; api.feedback({ ...fb, rating: null, dismissed: true }); closeIfRequested(); } }, { label: t.connect, on: () => { S.surveyOpen = false; S.surveyDone = true; handoff('survey'); } }], chipsCls: 'is-inline' });
    tail.querySelector('.dq-chat__bubble').style.paddingTop = '6px';
    async function rated(n) {
      fb.rating = n; tail.querySelector('.dq-chat__chips').classList.add('is-done');
      if (n <= 3) { await addBot(t.low, { chips: t.reasons.map(r => ({ label: r, on: (l) => reasoned([l]) })) }); S.pending = (txt) => reasoned([], txt); }
      else { await addBot(t.high, { chips: [{ label: t.allGood, cls: 'is-quiet', on: () => reasoned([]) }] }); S.pending = (txt) => reasoned([], txt); }
    }
    async function reasoned(reasons, comment) {
      S.pending = null; fb.reasons = reasons; if (comment) fb.comment = comment.replace(PII, '[redacted]').slice(0, 300);
      await addBot(t.resolvedQ, { lock: true, chipsCls: 'is-inline', chips: t.resolved.map((r, i) => ({ label: r, on: () => resolved(['yes', 'partly', 'no'][i]) })) });
    }
    async function resolved(v) {
      fb.resolved = v; S.surveyDone = true; S.surveyOpen = false; api.feedback(fb); api.end?.();
      await addBot(t.bye(data.visitor?.first)); closeIfRequested();
    }
  }
  async function askReasons(id) {
    await addBot(S.t.thumbsDownQ, { lock: true, chips: [...S.t.reasons.map(r => ({ label: r, on: (l) => { api.feedback({ kind: 'thumb_reason', message_id: id, reasons: [l] }); addBot(S.t.noted, { time: false }); } })), { label: S.t.skip, cls: 'is-quiet', on: () => { } }] });
  }
  function armIdle() { clearTimeout(S.idleTimer); if (!S.surveyDone) S.idleTimer = setTimeout(() => survey('idle'), CFG.idleSurveyMs); }
  let closeRequested = false;
  function closeIfRequested() { if (closeRequested) { closeRequested = false; toggle.checked = false; } }
  closeLbl.addEventListener('click', (e) => {
    if (!S.surveyDone && !S.surveyOpen && S.botAnswers >= 2 && toggle.checked) { e.preventDefault(); closeRequested = true; survey('close'); }
  });

  // ---------- input ----------
  async function send(raw) {
    const text = (raw ?? input.value).trim(); if (!text || S.busy || S.ended || (S.awaitChoice && raw == null)) return; // typed text waits for the required choice
    input.value = '';
    if (S.step === 'idle') setLang(isFil(text) ? 'fil' : 'en');
    if (PII.test(text) && S.step === 'done') { addUser(text.replace(PII, '[redacted]')); await addBot("Please don't share card, TIN or ID numbers here — I've hidden it. How else can I help?"); return; }
    if (S.pending) { addUser(text); const p = S.pending; S.pending = null; return p(text); }
    if (S.step === 'idle') { if (data.visitor && !S.confirming) { S.step = 'done'; addUser(text, { log: false }); return answer(text); } if (S.confirming) { addUser(text, { log: false }); S.held = text; return; } addUser(text, { held: true }); return startOnboarding(text); }
    // contact details live only in the visitor record: the log gets a stand-in
    if (S.step !== 'done') { addUser(text, { log: (S.step === 'phone' || S.step === 'phone_only') && !isQuestion(text) ? '[phone]' : true }); return onboardingInput(text); }
    if (BYE.test(text) && !S.surveyDone) { addUser(text); return survey('goodbye'); }
    addUser(text, { log: false });
    return answer(text);
  }
  sendBtn.addEventListener('click', () => send());
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  async function reset(opts = {}) {
    clearOnboardTimer();
    await flushLog(); outbox.length = 0; // what was already said stays with the old session
    if (banActive()) { addBot(S.t.endedNotice(untilText(banActive())), { time: false }); return endChat(banActive()); }
    store.del('visitor'); data.visitor = null; S.step = 'idle'; S.held = null; S.ended = false; S.awaitChoice = false; root.classList.remove('is-ended'); input.disabled = false; sendBtn.disabled = false; S.surveyDone = false; S.surveyOpen = false; S.botAnswers = 0; S.phoneTries = 0; S.confirming = false; S.needPhone = false;
    updatePlaceholder();
    body.innerHTML = ''; body.append(el('p', 'dq-chat__day', 'Today')); setStatus(); emit('reset', {});
    if (opts.notice) await addBot(opts.notice, { time: false });
    greet();
  }
  async function askReturningPhone() { S.needPhone = false; S.step = 'phone_only'; updatePlaceholder(); await addBot(S.t.needPhoneReturning(esc(data.visitor.first))); }
  async function greet() {
    const t = S.t;
    if (banActive()) { await addBot(t.endedNotice(untilText(banActive())), { time: false }); return endChat(banActive()); }
    if (data.visitor && S.needPhone) return askReturningPhone();
    if (data.visitor) {
      // same device within 30 days: one tap instead of signing up again; "Not me" runs the full sign-up
      S.confirming = true;
      await addBot(t.continueAs(esc(data.visitor.name || data.visitor.first), maskPhone(data.visitor.phone)), { lock: true, chipsCls: 'is-inline', chips: [
        { label: t.itsMe, cls: 'is-primary', on: async () => { S.confirming = false; S.step = 'done'; const held = S.held; S.held = null;
          if (held) return answer(held); await addBot(t.what, { chips: t.chips.map(l => ({ label: l, sends: true, on: (lab) => send(lab) })) }); } },
        { label: t.notMe, cls: 'is-quiet', on: async () => { S.confirming = false; const held = S.held; await reset(); if (held) startOnboarding(held); } }] });
      return;
    }
    await addBot(t.hello, { time: false });
    await addBot(t.what, { chips: t.chips.map(l => ({ label: l, sends: true, on: (lab) => send(lab) })) });
  }

  // ---------- boot ----------
  if (apiBase) {
    try {
      const b = await (await fetch(apiBase + '/ban', { headers: { 'x-des-device': deviceId }, cache: 'no-store' })).json();
      if (b.banned) store.set('endedUntil', b.until); else store.del('endedUntil');
    } catch { /* offline: fall back to the local copy */ }
  }
  if (banActive()) { endChat(banActive()); }
  const saved = store.get('visitor');
  if (saved && Date.now() - saved.saved_at < CFG.rememberDays * 864e5 && saved.consent?.version === CFG.consentVersion) {
    data.visitor = saved;
    const resumed = apiBase && token ? await realApi.resume() : false;
    if (resumed === 'phone') S.needPhone = true; // signed up before mobile numbers were required: ask for one first
    else if (apiBase && !resumed) { data.visitor = null; store.del('visitor'); } // token expired or missing → sign up again
  }
  setStatus();
  let greeted = false;
  let autoOpening = false;
  toggle.addEventListener('change', () => { if (toggle.checked && !greeted) { greeted = true; greet(); } if (toggle.checked && !autoOpening) setTimeout(() => input.focus(), 400); autoOpening = false; });
  if (toggle.checked) { greeted = true; greet(); }
  // pop the chat open after CFG.autoOpenMs, once per browser session; never over a visitor who closed it, never while paused
  const ssGet = (k) => { try { return sessionStorage.getItem('des:' + k); } catch { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem('des:' + k, v); } catch { } };
  if (CFG.autoOpenMs > 0 && !toggle.checked && !ssGet('autoOpened') && !banActive()) {
    setTimeout(() => {
      if (toggle.checked || ssGet('autoOpened')) return;
      ssSet('autoOpened', '1'); autoOpening = true; // no keyboard pop-up on phones when it opens by itself
      toggle.checked = true; toggle.dispatchEvent(new Event('change'));
      emit('auto_open', {});
    }, CFG.autoOpenMs);
  }
  toggle.addEventListener('change', () => ssSet('autoOpened', '1')); // opened or closed by hand: don't auto-open again this session
  window.DES = { data, send, survey: () => survey('manual'), reset, trouble: () => trouble('manual') };
  emit('boot', {});
})();
