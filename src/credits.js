/**
 * Credit guard — makes sure Memoria never runs dry on a partner's credits.
 *
 * Every paid call is written to credit_ledger. Before a call, `allow()` checks the
 * month's usage against a budget (env-configurable, with a safety reserve) and
 * OpenRouter's free-model requests left today. Lifetime families are served first; free families fall
 * back to the browser transcript or the backup model, and keep the text if storage is nearly full.
 */
const db = require('./db');
const openrouter = require('./openrouter');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const BUDGET = {
  stt_minutes: num('SCRIBE_MONTHLY_MINUTES', 300),
  tinker_calls: num('TINKER_MONTHLY_CALLS', 400),
  storage_mb: num('NEON_STORAGE_MB', 1024)               // Neon branch size limit; recordings live here
};
const RESERVE = 0.1; // keep 10% of every monthly budget back for paying families

let freeToday = null; // { used, limit, remaining } for OpenRouter free models, refreshed every few minutes
let freeCheckedAt = 0;

async function refreshOpenRouter() {
  if (!openrouter.enabled()) return null;
  freeToday = await openrouter.freeUsage() || freeToday;
  freeCheckedAt = Date.now();
  if (freeToday) await db.setCredit('openrouter', 'OpenRouter free models (requests left today)', freeToday.remaining, 'requests_left', freeToday.limit);
  return freeToday;
}

async function monthUsage() {
  const rows = await db.q(`SELECT kind, COALESCE(SUM(units), 0)::float AS units FROM credit_ledger
                           WHERE created_at >= date_trunc('month', now()) GROUP BY kind`);
  const used = Object.fromEntries(rows.map(r => [r.kind, r.units]));
  const size = await db.one(`SELECT pg_database_size(current_database())::float / 1048576 AS mb`);
  used.storage_mb = size?.mb || 0;
  return used;
}

/** Is there room for `units` more of `kind` for this family? */
async function allow(kind, units, family) {
  if (kind === 'openrouter') {
    if (Date.now() - freeCheckedAt > 5 * 60_000) await refreshOpenRouter();
    if (!freeToday?.limit) return true;
    const ceiling = family?.plan === 'lifetime' ? freeToday.limit : freeToday.limit * (1 - RESERVE);
    if (freeToday.used + units > ceiling) return false;
    freeToday.used += units; // count it now; the next refresh brings the real number
    return true;
  }
  const budget = BUDGET[kind];
  if (!budget) return true;
  const used = (await monthUsage())[kind] || 0;
  const ceiling = family?.plan === 'lifetime' ? budget : budget * (1 - RESERVE);
  return used + units <= ceiling;
}

function record(familyId, kind, units, note = null) {
  return db.q('INSERT INTO credit_ledger (family_id, kind, units, note) VALUES ($1,$2,$3,$4)', [familyId || null, kind, units, note])
    .catch(e => console.warn('ledger:', e.message));
}

/** Writes the current picture of every budget, for Pulse. */
async function snapshot() {
  const used = await monthUsage();
  await Promise.all([
    refreshOpenRouter(),
    db.q(`DELETE FROM credits WHERE provider = 'backboard'`).catch(() => {}),
    db.setCredit('elevenlabs_stt', 'ElevenLabs transcription (minutes this month)', BUDGET.stt_minutes - (used.stt_minutes || 0), 'minutes_left', BUDGET.stt_minutes),
    db.setCredit('neon_storage', 'Recording storage (database)', Math.round(BUDGET.storage_mb - (used.storage_mb || 0)), 'mb_left', BUDGET.storage_mb),
    db.setCredit('tinker', 'Tinker backup model (calls this month)', BUDGET.tinker_calls - (used.tinker_calls || 0), 'calls_left', BUDGET.tinker_calls)
  ]);
}

function start() {
  snapshot().catch(e => console.warn('credit snapshot:', e.message));
  setInterval(() => snapshot().catch(() => {}), 10 * 60_000).unref();
}

module.exports = { allow, record, snapshot, start, BUDGET };
