// Guardrails run in code (architecture.md §5b C). The prompt asks nicely; this enforces.
import { cfg } from './config.js';

export const MAX_INPUT_CHARS = 1000;

// ---- PII masking (cards, TIN, SSS, PhilHealth / Pag-IBIG-shaped numbers) ----
const PII = [
  /\b(?:\d[ -]?){13,19}\b/g,                 // card numbers
  /\b\d{3}-\d{3}-\d{3}(?:-\d{3,5})?\b/g,     // TIN 000-000-000(-000)
  /\b\d{2}-\d{7}-\d\b/g,                     // SSS
  /\b\d{2}-\d{9}-\d\b/g,                     // PhilHealth
  /\b\d{4}-\d{4}-\d{4}\b/g,                  // Pag-IBIG MID
];
export function maskPII(text) {
  let masked = text, hits = 0;
  for (const re of PII) masked = masked.replace(re, (m) => { if (/^\+?63|^09/.test(m.replace(/[ -]/g, ''))) return m; hits++; return '[redacted]'; });
  return { text: masked, hits };
}

// ---- prompt-injection screen ----
const INJECTION = [
  /ignore (all |the |your )?(previous|prior|above) (instructions|rules|prompt)/i,
  /\b(system prompt|system instruction|developer message)\b/i,
  /\byou are now\b|\bact as (a|an) (?!customer|buyer)/i,
  /\bjailbreak|DAN mode|developer mode\b/i,
  /\breveal (your|the) (prompt|instructions|rules)\b/i,
  /<\|?(system|im_start|assistant)\|?>/i,
  /\bbase64\b.*[A-Za-z0-9+/]{40,}/,
];
export function injectionScore(text) { return INJECTION.filter((re) => re.test(text)).length; }

// ---- cheap topic classifier (regex first; LLM classifier optional in llm.js) ----
const ABUSE = /\b(f+u+c+k+(ing|er|ed)?|fck|fuk|stfu|shit|bitch|asshole|bastard|dickhead|motherfucker|puta|putang ?ina|tang ?ina|tangina|ina mo|gago|gaga|kupal|bobo|tanga|ulol|ulul|tarantado|punyeta|leche|pakyu|pak yu|hayop ka|siraulo|inutil|engot|hinayupak|pokpok|tite|puke|kantot|jakol)\b/i;
const SUPPORT = /\b(error|not working|can'?t (login|log in|open)|down|crash|bug|license expired|ticket|urgent issue|our sap (is|was))\b/i;
const OFFTOPIC = /\b(homework|assignment|thesis|recipe|cook(ing)?|bake|weather|horoscope|zodiac|stock price|bitcoin|crypto|election|president|politics|basketball|nba|movie|netflix|anime|video ?game|joke|riddle|girlfriend|boyfriend|crush|date me|marry me|love you|write (me )?(code|a script|a program)|python|javascript|html|css|sql query|translate this|luto|magluto|lutuin|ulam|sinigang|adobo|tinola|kare-?kare|jowa|landi|inom|tagay|gala tayo|takdang[- ]aralin)\b|\bsan tayo\b|\btara (inom|gala|kain)\b/i;
// long-form or creative writing is off-topic even when it mentions SAP ("write 10 paragraphs on why I need SAP")
const LONGFORM = /\b(essay|article|blog post|poem|tula|kanta|song|lyrics|short story|kwento)\b/i;
const MANY = /(\d+)\s*(paragraphs?|talata|pages?|pahina)\b/i;
export function classify(text) {
  if (ABUSE.test(text)) return 'abuse';
  if (SUPPORT.test(text)) return 'support_request';
  const many = text.match(MANY);
  if (LONGFORM.test(text) || (many && Number(many[1]) >= 4)) return 'off_topic';
  if (OFFTOPIC.test(text) && !/\b(sap|erp|dynamiq|iq |bir|accounting|payroll|inventory|barcode)\b/i.test(text)) return 'off_topic';
  return 'on_topic';
}

// ---- language ----
export function detectLang(text) {
  const fil = /\b(ba|ng|mga|ako|kami|namin|natin|po|kayo|sana|paano|magkano|ano|saan|kailangan|gusto|pwede|puwede|yung|lang|salamat|kumusta|hindi|oo|sige|ninyo|niyo)\b/i;
  const en = /\b(the|and|for|with|our|we|you|is|are|do|does)\b/i;
  const f = (text.match(fil) || []).length, e = (text.match(en) || []).length;
  return f > 0 && f >= e ? 'fil' : 'en';
}

// ---- output filters ----
const PRICE = [/₱\s?\d/, /\bPHP\s?\d/i, /\bP\s?\d{2,3}(,\d{3})+/, /\$\s?\d/, /\bper (user|seat)( per| \/)? (month|year)\b/i, /\b\d{1,2}\s?% (off|discount)\b/i, /\bstarts? at\b.*\d/i, /\b\d{2,3},\d{3}\b/];
const CLAIMS = [/\bguaranteed?\b/i, /\bBIR[- ]approved\b/i, /\b(ISO|SOC ?2|GDPR|HIPAA)[- ](certified|compliant)\b/i, /\bno downtime\b/i, /\bfree of charge\b/i, /\bcheapest\b/i, /\b(netsuite|odoo|quickbooks|xero|microsoft dynamics|oracle)\b.{0,40}\b(bad|worse|terrible|inferior|slow|unreliable)\b/i];
const ALLOWED_HOSTS = ['dynamiqes.com', 'www.dynamiqes.com', 'maps.app.goo.gl'];

export function filterOutput(text, { systemPrompt = '', visitorContact = '' } = {}) {
  const reasons = [];
  if (PRICE.some((re) => re.test(text))) reasons.push('price');
  if (CLAIMS.some((re) => re.test(text))) reasons.push('claim');
  if (visitorContact && text.includes(visitorContact)) reasons.push('contact_echo');
  if (systemPrompt && text.length > 200 && systemPrompt.includes(text.slice(0, 200))) reasons.push('prompt_leak');

  // links: strip anything not on the allow-list
  let out = text.replace(/https?:\/\/[^\s)>\]]+/g, (u) => {
    try { const h = new URL(u).hostname; return ALLOWED_HOSTS.includes(h) ? u : '[link removed]'; } catch { return '[link removed]'; }
  });
  // format: no headings, tables, code fences; keep bullets/links
  out = out.replace(/^#{1,6}\s+/gm, '').replace(/```[\s\S]*?```/g, '').replace(/^\|.*\|\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > 1400) out = out.slice(0, 1400).replace(/\s+\S*$/, '') + '…';
  return { text: out, reasons };
}

export const CANNED = {
  en: {
    offtopic: "I'm DES, DynamIQ's assistant — I can help with SAP Business One, the IQ Suite, BIR CAS compliance, our services and careers. What would you like to know?",
    injection: "I can only help with DynamIQ topics. What would you like to know about our products or services?",
    abuse: "I'm here to help with DynamIQ products and services. If you'd rather speak with a person, our team is at sales@dynamiqes.com or +63 917-630-4848.",
    support: "For technical issues with your system, please reach our Helpdesk directly so a consultant can assist right away: +63 (2) 8365 0228 or +63 917-630-4848 (Mon–Fri, 8 AM–5 PM), or email your assigned consultant.",
    price: "I'm not able to give pricing here — every setup is scoped to the business (users, cloud or on-site, modules, add-ons). The best next step is a free business analysis with our team; they'll send a tailored proposal within 24 hours: https://dynamiqes.com/book-free-demo/",
    trouble: "Sorry — I'm having trouble with that one. Let me connect you with one of our sales consultants: sales@dynamiqes.com or +63 917-630-4848 (Mon–Fri, 8 AM–5 PM).",
    budget: "Our assistant is taking a short break. Leave your question here and a DynamIQ consultant will reply within 24 hours, or call +63 917-630-4848.",
    tooLong: 'Could you shorten that a little? Up to about 1,000 characters per message, please.',
    strikeWarn: "If we keep going off-topic, I'll have to end this chat.",
    ended: "I'm ending this chat because it has gone off-topic. If you have a question about DynamIQ, SAP Business One or our services, our team is happy to help: sales@dynamiqes.com or +63 917-630-4848 (Mon–Fri, 8 AM–5 PM).",
  },
  fil: {
    offtopic: 'Ako si DES, ang assistant ng DynamIQ — makakatulong ako sa SAP Business One, IQ Suite, BIR CAS compliance, mga serbisyo at careers. Ano ang gusto mong malaman?',
    injection: 'Sa mga tungkol sa DynamIQ lang ako makakatulong. Ano ang gusto mong malaman sa aming products o services?',
    abuse: 'Nandito ako para tumulong sa DynamIQ products at services. Kung gusto mo ng tao, nasa sales@dynamiqes.com o +63 917-630-4848 ang team namin.',
    support: 'Para sa technical na problema sa system ninyo, tawagan ang Helpdesk para masagot agad ng consultant: +63 (2) 8365 0228 o +63 917-630-4848 (Lun–Biy, 8 AM–5 PM).',
    price: 'Hindi ako makapagbigay ng presyo dito — bawat setup ay naka-scope sa negosyo (users, cloud o on-site, modules, add-ons). Pinakamabilis ang free business analysis; magpapadala ang team ng proposal sa loob ng 24 oras: https://dynamiqes.com/book-free-demo/',
    trouble: 'Pasensya na — nahihirapan ako diyan. Ikokonekta kita sa sales consultant namin: sales@dynamiqes.com o +63 917-630-4848 (Lun–Biy, 8 AM–5 PM).',
    budget: 'Nagpapahinga saglit ang assistant. Iwan mo ang tanong mo dito at sasagot ang consultant ng DynamIQ sa loob ng 24 oras, o tumawag sa +63 917-630-4848.',
    tooLong: 'Pwede bang paikliin nang kaunti? Hanggang mga 1,000 characters bawat mensahe.',
    strikeWarn: 'Kung patuloy tayong lalayo sa usapan, kailangan ko nang tapusin ang chat na ito.',
    ended: 'Tatapusin ko na ang chat na ito dahil napupunta na sa ibang usapan. Kung may tanong ka tungkol sa DynamIQ, SAP Business One o sa aming serbisyo, nandito ang team namin: sales@dynamiqes.com o +63 917-630-4848 (Lun–Biy, 8 AM–5 PM).',
  },
};
