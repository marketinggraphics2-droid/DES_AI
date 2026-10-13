// Who may do what in the dashboard. Edit this one file to change the defaults.
// Every admin API route must be listed in ROUTES; a route that is not listed is refused (deny by default).

export const ROLES = ['superuser', 'admin', 'user'];
export const ROLE_LABEL = { superuser: 'Superuser', admin: 'Admin', user: 'User' };

const ALL = ['superuser', 'admin', 'user'];
const ADMINS = ['superuser', 'admin'];
const SUPER = ['superuser'];

/** permission -> roles that have it */
export const PERMISSIONS = {
  'overview.view': ALL,            // Overview page, activity, live updates
  'conversations.view': ALL,       // Conversations (read)
  'contacts.full': ADMINS,         // visitor phone / email in full (User role sees them masked)
  'leads.view': ALL,
  'leads.status': ALL,             // change a lead's status
  'remarks.add': ALL,              // add remarks to a conversation (e.g. call notes); delete your own
  'leads.export': ADMINS,          // Leads CSV export (and the approved-answer training file)
  'share.create': ADMINS,          // share links for a conversation
  'finetune.manage': ADMINS,       // Fine-tune answers, Needs review, product notes, test box
  'kb.manage': ADMINS,             // Website knowledge
  'facts.manage': ADMINS,          // Facts & glossary
  'bans.manage': ADMINS,
  'prompt.manage': SUPER,          // DES instructions
  'visitors.delete': SUPER,        // delete a visitor's data (privacy request)
  'settings.manage': SUPER,        // budget / system settings, allowed websites
  'users.manage': SUPER,           // user management
  'audit.view': SUPER,             // audit log
};

/** [method, path pattern (under /api/admin), permission]. 'signed_in' = any signed-in user. */
export const ROUTES = [
  ['GET', '/auth/me', 'signed_in'], ['POST', '/auth/logout', 'signed_in'], ['POST', '/auth/password', 'signed_in'],
  ['GET', '/status', 'signed_in'],
  ['GET', '/stream', 'overview.view'],
  ['GET', '/overview', 'overview.view'], ['GET', '/activity', 'overview.view'], ['GET', '/feedback/summary', 'overview.view'],
  ['GET', '/conversations', 'conversations.view'], ['GET', '/conversations/:id', 'conversations.view'],
  ['GET', '/conversations/:id/detail', 'conversations.view'], ['GET', '/conversations/:id/history', 'conversations.view'],
  ['GET', '/leads', 'leads.view'], ['PUT', '/leads/:id', 'leads.status'],
  ['GET', '/conversations/:id/remarks', 'conversations.view'], ['POST', '/conversations/:id/remarks', 'remarks.add'], ['DELETE', '/remarks/:id', 'remarks.add'],
  ['GET', '/export/leads.csv', 'leads.export'], ['GET', '/export/finetune.jsonl', 'leads.export'],
  ['POST', '/conversations/:id/share', 'share.create'], ['GET', '/shares', 'share.create'], ['DELETE', '/shares/:id', 'share.create'],
  ['GET', '/products', 'finetune.manage'], ['GET', '/products/:name', 'finetune.manage'], ['PUT', '/products/:name/notes', 'finetune.manage'],
  ['GET', '/golden', 'finetune.manage'], ['POST', '/golden', 'finetune.manage'], ['PUT', '/golden/:id', 'finetune.manage'], ['DELETE', '/golden/:id', 'finetune.manage'],
  ['POST', '/test', 'finetune.manage'], ['POST', '/match', 'finetune.manage'], ['GET', '/review-queue', 'finetune.manage'],
  ['GET', '/kb', 'kb.manage'], ['PUT', '/kb/:id', 'kb.manage'], ['POST', '/ingest', 'kb.manage'],
  ['GET', '/facts', 'facts.manage'], ['PUT', '/facts/:key', 'facts.manage'], ['DELETE', '/facts/:key', 'facts.manage'],
  ['GET', '/glossary', 'facts.manage'], ['PUT', '/glossary/:term', 'facts.manage'], ['DELETE', '/glossary/:term', 'facts.manage'],
  ['GET', '/bans', 'bans.manage'], ['DELETE', '/bans', 'bans.manage'],
  ['GET', '/prompt', 'prompt.manage'], ['POST', '/prompt', 'prompt.manage'],
  ['DELETE', '/visitors/:id', 'visitors.delete'],
  ['GET', '/settings', 'settings.manage'], ['PUT', '/settings', 'settings.manage'],
  ['GET', '/sites', 'settings.manage'], ['POST', '/sites', 'settings.manage'], ['DELETE', '/sites', 'settings.manage'],
  ['GET', '/users', 'users.manage'], ['POST', '/users', 'users.manage'], ['PUT', '/users/:id', 'users.manage'], ['POST', '/users/:id/password', 'users.manage'],
  ['GET', '/audit', 'audit.view'],
];

const compiled = ROUTES.map(([m, p, perm]) => [m, new RegExp('^' + p.replace(/:[a-z]+/g, '[^/]+').replace(/\./g, '\\.') + '/?$'), perm]);
/** Permission needed for this request, or null when the route is not listed (refused). */
export function routePermission(method, path) {
  const m = method === 'HEAD' ? 'GET' : method;
  return compiled.find(([mm, re]) => mm === m && re.test(path))?.[2] || null;
}
export const can = (role, perm) => perm === 'signed_in' ? ROLES.includes(role) : (PERMISSIONS[perm] || []).includes(role);
export const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((p) => can(role, p));

// ---- masking for roles without contacts.full: applied to every admin response and live event ----
export function maskPhone(p) {
  const s = String(p || ''); const d = s.replace(/\D/g, '');
  if (d.length < 7) return s ? '•••' : s;
  return (s.startsWith('+') ? '+' : '') + d.slice(0, d.length - 7).replace(/\d/g, (c, i) => (i < 3 ? c : '•')) + '•••' + d.slice(-4);
}
export function maskEmail(e) {
  const s = String(e || ''); const at = s.indexOf('@');
  return at < 1 ? (s ? '•••' : s) : s[0] + '•••' + s.slice(at);
}
const PHONE_KEYS = new Set(['phone', 'contact']), EMAIL_KEYS = new Set(['email']);
/** Deep copy with phone / email fields masked. */
export function maskContacts(v) {
  if (Array.isArray(v)) return v.map(maskContacts);
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (PHONE_KEYS.has(k) && typeof x === 'string') out[k] = maskPhone(x);
    else if (EMAIL_KEYS.has(k) && typeof x === 'string') out[k] = maskEmail(x);
    else out[k] = maskContacts(x);
  }
  return out;
}
