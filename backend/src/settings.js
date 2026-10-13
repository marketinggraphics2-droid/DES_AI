// System settings a superuser can change in the dashboard; they override .env without a restart.
import { cfg } from './config.js';
import { q } from './db.js';

const num = (min, max) => (v) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const DEFAULTS = { dailyBudgetUsd: cfg.dailyBudgetUsd };
/** key (app_settings), label, how to read the value, and the config field it overrides */
export const SETTINGS = [
  { key: 'daily_budget_usd', label: 'Daily AI budget (USD)', help: 'At 100 % DES stops calling the AI and hands chats to Sales.', parse: num(0, 10000), apply: (v) => { cfg.dailyBudgetUsd = v ?? DEFAULTS.dailyBudgetUsd; }, current: () => cfg.dailyBudgetUsd },
];

/** Load the stored values into cfg (on start and after a change). */
export async function invalidateSettings() {
  const rows = Object.fromEntries((await q('select key, value from app_settings')).rows.map((r) => [r.key, r.value]));
  for (const s of SETTINGS) s.apply(rows[s.key] != null ? s.parse(rows[s.key]) : null);
}
