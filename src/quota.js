/**
 * Cost guard. Free is generous, but the things that cost money are metered so a spike in free
 * usage can never turn into a bill:
 *   - each family: Ask questions per day (plan limit) and AI actions per hour (anti-abuse)
 *   - all free families together: model calls per day (FREE_AI_DAILY_CAP). Past it, free families
 *     get the built-in engine (still only their real words, quoted verbatim); Lifetime is never capped.
 * One server instance, so in-memory counters are enough; a restart only makes it more lenient.
 */
const day = () => new Date().toISOString().slice(0, 10);
const hour = () => Math.floor(Date.now() / 3_600_000);

const FREE_AI_DAILY_CAP = Number(process.env.FREE_AI_DAILY_CAP) || 1200;
let freeAi = { day: day(), n: 0 };
const perFamily = new Map();

function bump(key) {
  const n = (perFamily.get(key) || 0) + 1;
  perFamily.set(key, n);
  if (perFamily.size > 50_000) perFamily.clear();
  return n;
}

/** May this family's request use a hosted model right now? Counts the call if yes. */
function allowModel(family) {
  if (family?.plan === 'lifetime') return true;
  if (freeAi.day !== day()) freeAi = { day: day(), n: 0 };
  if (freeAi.n >= FREE_AI_DAILY_CAP) return false;
  freeAi.n++;
  return true;
}

/** Counts one Ask; returns false once the family is over its daily allowance. */
const allowAsk = (family, perDay) => bump(`ask:${family.id}:${day()}`) <= perDay;

/** Hourly anti-abuse ceiling for anything that calls a model. */
const allowAction = (family, perHour) => bump(`act:${family.id}:${hour()}`) <= perHour;

const status = () => ({ free_ai_today: freeAi.day === day() ? freeAi.n : 0, free_ai_cap: FREE_AI_DAILY_CAP });

module.exports = { allowModel, allowAsk, allowAction, status };
