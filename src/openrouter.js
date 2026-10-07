/**
 * OpenRouter — one API key for open-weight models. Memoria runs on the free (`:free`)
 * variants: Gemma 4 31B first, Gemma 4 26B as the fast fallback, Nemotron as a last open model.
 * Free variants allow 20 requests/minute and 50/day (1000/day once the account has bought $10).
 * Docs: https://openrouter.ai/docs
 */

const { configured } = require('./env');

const BASE = 'https://openrouter.ai/api/v1';
const API_KEY = configured('OPENROUTER_API_KEY');
const MODELS = [
  process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free',
  process.env.OPENROUTER_FAST_MODEL || 'google/gemma-4-26b-a4b-it:free',
  process.env.OPENROUTER_BACKUP_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free'
].filter((m, i, a) => m && a.indexOf(m) === i);

let models = MODELS;
const cooling = new Map(); // model → time it may be tried again after a 429

const enabled = () => !!API_KEY;
const label = m => m.replace(/:free$/, '');
const modelLabel = () => label(models[0]);
const headers = () => ({
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.PUBLIC_URL || 'https://memoria-family.vercel.app',
  'X-Title': 'Memoria'
});

async function chat(model, prompt, system, timeoutMs) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1200 }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (res.status === 429) cooling.set(model, Date.now() + 60_000);
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/** Tries each model in turn (skipping ones that were just rate-limited). Returns { text, engine } or null. */
async function complete(prompt, system, { timeoutMs = 20_000 } = {}) {
  for (const model of models) {
    if ((cooling.get(model) || 0) > Date.now()) continue;
    try {
      const text = await chat(model, prompt, system, timeoutMs);
      if (text) return { text, engine: `openrouter:${label(model)}` };
    } catch (e) { console.warn(`OpenRouter ${label(model)} failed:`, e.message); }
  }
  return null;
}

/** Keep only the configured models OpenRouter still lists (free variants come and go). */
async function discoverModel() {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(10_000) });
    const ids = new Set(((await res.json()).data || []).map(m => m.id));
    const live = MODELS.filter(m => ids.has(m));
    if (live.length) models = live;
    console.log(`🧩 OpenRouter: using ${models.map(label).join(' → ')}`);
  } catch (e) {
    console.warn('OpenRouter model check failed (using configured models):', e.message);
  }
  return models[0];
}

/** Today's free-model request counter: { used, limit, remaining } or null. */
async function freeUsage() {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`${BASE}/key`, { headers: headers(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()).data?.free_model_daily_requests || null;
  } catch { return null; }
}

module.exports = { enabled, complete, discoverModel, freeUsage, modelLabel };
