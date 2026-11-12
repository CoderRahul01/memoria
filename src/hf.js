/**
 * Hugging Face Inference Providers: Gemma 4 on pay-as-you-go credits, used as the overflow when
 * Gemini's free tier is rate-limited. OpenAI-compatible router; every call's real token usage is
 * priced and written to the credit ledger, and a monthly dollar budget stops spend before the
 * credits run dry (see credits.js, kind 'hf_usd').
 *
 * Default: google/gemma-4-26B-A4B-it via DeepInfra, $0.07 / M input, $0.34 / M output tokens
 * (router.huggingface.co/v1/models, Nov 2026). Override with HF_MODEL / HF_PRICE_IN / HF_PRICE_OUT.
 */
const { configured } = require('./env');

const TOKEN = configured('HF_TOKEN');
const MODEL = process.env.HF_MODEL || 'google/gemma-4-26B-A4B-it:deepinfra';
const PRICE_IN = Number(process.env.HF_PRICE_IN) || 0.07;   // USD per million input tokens
const PRICE_OUT = Number(process.env.HF_PRICE_OUT) || 0.34; // USD per million output tokens
let coolUntil = 0;

const enabled = () => !!TOKEN && Date.now() > coolUntil;
const label = () => MODEL.replace(/:.*$/, '');

/** Rough upper bound before a call, so the budget check happens first. ~4 chars per token. */
const estimateUsd = (prompt, system, maxOut = 600) =>
  ((String(prompt).length + String(system || '').length) / 4 * PRICE_IN + maxOut * PRICE_OUT) / 1e6;

/** Returns { text, engine, usd } or null. Never throws. */
async function complete(prompt, system, { maxTokens = 1200, timeoutMs = 30_000 } = {}) {
  if (!enabled()) return null;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  try {
    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      if (res.status === 429 || res.status === 402) coolUntil = Date.now() + (res.status === 402 ? 3_600_000 : 60_000);
      console.warn(`HF ${res.status}:`, (await res.text()).slice(0, 160));
      return null;
    }
    const data = await res.json();
    // Some open models think out loud first; keep only the answer.
    const text = String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) return null;
    const u = data.usage || {};
    const usd = ((u.prompt_tokens || 0) * PRICE_IN + (u.completion_tokens || 0) * PRICE_OUT) / 1e6;
    return { text, engine: `hf:${label()}`, usd };
  } catch (e) {
    console.warn('HF error:', e.message);
    return null;
  }
}

module.exports = { enabled, complete, estimateUsd, modelLabel: label };
