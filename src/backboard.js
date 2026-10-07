/**
 * Backboard — one API key for open-weight models (Gemma via OpenRouter) plus
 * per-assistant memory + retrieval. Each loved one gets their own assistant;
 * every saved memory is written into that assistant's memory, and "Ask" reads it back.
 * Docs: https://docs.backboard.io
 */

const { configured } = require('./env');

const BASE = 'https://app.backboard.io/api';
const API_KEY = configured('BACKBOARD_API_KEY');
const PROVIDER = process.env.BACKBOARD_LLM_PROVIDER || 'openrouter';
let model = process.env.BACKBOARD_MODEL || 'google/gemma-4-31b-it';

const threads = new Map(); // assistant id → thread_id, so follow-up questions keep context

const enabled = () => !!API_KEY;
const modelLabel = () => `${PROVIDER}/${model}`.replace(/^openrouter\/(?=google)/, '');

async function bb(path, body, method = 'POST', timeoutMs = 60_000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-API-Key': API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Backboard ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Pick a Gemma model that this account can actually reach (logs what it found). */
async function discoverModel() {
  if (!API_KEY) return null;
  try {
    const { models = [] } = await bb(`/models?model_type=llm&provider=${encodeURIComponent(PROVIDER)}&limit=15000`, null, 'GET');
    const gemmas = models.map(m => m.name).filter(n => /gemma/i.test(n));
    if (gemmas.length && !gemmas.includes(model)) {
      // Prefer the largest instruction-tuned, non-free-tier Gemma.
      const gen = n => +(n.match(/gemma-(\d+)/i)?.[1] || 0);
      const size = n => +(n.match(/(\d+)b/i)?.[1] || 0);
      model = gemmas.filter(n => /it/i.test(n) && !/:free/.test(n)).sort((a, b) => gen(b) - gen(a) || size(b) - size(a))[0] || gemmas[0];
    }
    console.log(`🧩 Backboard: ${gemmas.length} Gemma models on ${PROVIDER}; using ${model}`);
  } catch (e) {
    console.warn('Backboard model discovery failed (using configured model):', e.message);
  }
  return model;
}

function systemPrompt(personName) {
  return `You are Memoria, speaking for ${personName} using ONLY memories they recorded for their family.
Answer warmly in the first person as ${personName}, under 4 sentences, keeping exact details (quantities, names, places, years).
If the memories don't contain the answer, say honestly that ${personName} hasn't recorded that yet and suggest asking them about it. Never invent facts.`;
}

/** Create (once) the assistant that holds this person's memories. */
async function ensureAssistant(person) {
  if (person.backboard_assistant_id) return person.backboard_assistant_id;
  const a = await bb('/assistants', { name: `Memoria · ${person.name} · ${String(person.family_id).slice(0, 8)}`, system_prompt: systemPrompt(person.name) });
  return a.assistant_id;
}

async function addMemory(assistantId, memory) {
  const when = memory.memory_date ? ` (${memory.memory_date})` : '';
  return bb(`/assistants/${assistantId}/memories`, {
    content: `${memory.title}${when}: ${memory.content}`,
    metadata: { memoria_id: memory.id, category: memory.category, title: memory.title }
  });
}

/**
 * Ask with Backboard memory retrieval. `context` is a locally-ranked fallback so the
 * answer stays grounded even if retrieval returns nothing.
 */
/** Plain completion on a scratch assistant (memory off) — titles, tags, tributes. */
let writerId = null;
async function complete(prompt, system, { modelName = model, timeoutMs = 60_000 } = {}) {
  writerId ||= (await bb('/assistants', { name: 'Memoria · Writer', system_prompt: 'You are a careful, warm writing assistant.' })).assistant_id;
  const r = await bb('/threads/messages', {
    content: prompt,
    assistant_id: writerId,
    llm_provider: PROVIDER,
    model_name: modelName,
    memory: 'off',
    ...(system ? { system_prompt: system } : {})
  }, 'POST', timeoutMs);
  return (r.content || '').trim();
}

async function ask(assistantId, personName, question, context, timeoutMs = 60_000) {
  const body = {
    content: context ? `${question}\n\n(Possibly relevant memories:\n${context})` : question,
    assistant_id: assistantId,
    llm_provider: PROVIDER,
    model_name: model,
    memory: 'Readonly',             // read the family's memories, never write questions into them
    system_prompt: systemPrompt(personName)
  };
  const prior = threads.get(assistantId);
  if (prior) body.thread_id = prior;

  let r;
  try { r = await bb('/threads/messages', body, 'POST', timeoutMs); }
  catch (e) {
    if (!prior) throw e;
    threads.delete(assistantId);      // stale thread — retry fresh
    delete body.thread_id;
    r = await bb('/threads/messages', body, 'POST', timeoutMs);
  }
  if (r.thread_id) threads.set(assistantId, r.thread_id);
  return {
    text: (r.content || r.message || '').trim(),
    retrieved: (r.retrieved_memories || []).map(m => m.memory),
    engine: `backboard:${r.model_name || model}`
  };
}

const warm = () => complete('Reply with OK.', null, { timeoutMs: 20_000 }).catch(() => {});

module.exports = { enabled, warm, discoverModel, ensureAssistant, addMemory, ask, complete, modelLabel };
