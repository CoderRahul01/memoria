/**
 * Open-weight model layer — no Google key, no local runtime. Engines tried in order:
 *   1. Gemma 4 through OpenRouter (free tier, open weights)           OPENROUTER_API_KEY
 *   2. An open model checkpoint served by Tinker                     TINKER_API_KEY + TINKER_MODEL_PATH
 *   3. Built-in heuristics (no AI, but never breaks)
 * Every function returns a useful result and reports which engine produced it.
 */

const { configured } = require('./env');
const openrouter = require('./openrouter');
const credits = require('./credits');

const TINKER_KEY = configured('TINKER_API_KEY');
const TINKER_BASE = process.env.TINKER_BASE_URL || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1';
// Tinker's OpenAI-compatible API serves Tinker checkpoints (tinker://…/sampler_weights/…), not bare model names.
const TINKER_PATH = (configured('TINKER_MODEL_PATH') || '').startsWith('tinker://') ? configured('TINKER_MODEL_PATH') : null;
const TINKER_LABEL = process.env.TINKER_MODEL || 'Qwen/Qwen3.6-35B-A3B';

async function viaTinker(prompt, system) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch(`${TINKER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TINKER_KEY}`
    },
    // Qwen 3.6 reasons before answering, so leave room for the thinking tokens too.
    body: JSON.stringify({ model: TINKER_PATH, messages, temperature: 0.3, max_tokens: 3000 }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok) throw new Error(`Tinker ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/** Returns { text, engine } or null when no model is reachable. */
async function generate(prompt, system, family = null) {
  if (openrouter.enabled() && await credits.allow('openrouter', 1, family)) {
    const out = await openrouter.complete(prompt, system);
    if (out) return out;
  }
  if (TINKER_KEY && TINKER_PATH && await credits.allow('tinker_calls', 1, family)) {
    try {
      const text = await viaTinker(prompt, system);
      credits.record(family?.id, 'tinker_calls', 1);
      return { text, engine: `tinker:${TINKER_LABEL}` };
    }
    catch (e) { console.warn('Tinker failed:', e.message); }
  }
  return null;
}

// ── Heuristic helpers (used when no model is available) ────────
const STOP = new Set(('a an the and or but if then so of to in on at by for with from as is was were be been am are it its this that ' +
  'these those i me my we our you your he she him her his they them their what which who whom when where why how do did does ' +
  'had has have not no yes just very really there here about into over after before up down out all any some can could would ' +
  'should will one two also than too us like get got go went said tell told know remember used much many more most').split(' '));

function keywords(text) {
  return (text.toLowerCase().match(/[a-zÀ-ɏऀ-ॿ']{3,}/g) || []).filter(w => !STOP.has(w));
}

const CATEGORY_HINTS = {
  recipe: ['recipe', 'cook', 'cooking', 'masala', 'spice', 'bake', 'boil', 'fry', 'teaspoon', 'cup', 'dish', 'kitchen', 'biryani', 'curry', 'dough', 'ingredient'],
  advice: ['advice', 'always', 'never', 'should', 'lesson', 'learn', 'promise', 'remember', 'important', 'honest', 'patience'],
  family: ['mother', 'father', 'wife', 'husband', 'son', 'daughter', 'brother', 'sister', 'grandmother', 'grandfather', 'wedding', 'married', 'born', 'baby'],
  place: ['village', 'city', 'house', 'home', 'street', 'river', 'town', 'country', 'moved', 'travel', 'train'],
  event: ['war', 'partition', 'festival', 'election', 'flood', 'year', 'independence', 'diwali', 'eid', 'christmas']
};

function heuristicExtract(text) {
  const words = keywords(text);
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const tags = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w);

  let category = 'story', best = 0;
  for (const [cat, hints] of Object.entries(CATEGORY_HINTS)) {
    const score = hints.reduce((s, h) => s + (freq[h] || 0), 0);
    if (score > best) { best = score; category = cat; }
  }

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0].trim();
  // Prefer the first clause ("My biryani secret: …" → "My biryani secret") when it's a natural length.
  const clause = firstSentence.split(/\s*[:;,—–]\s*|\s+-\s+/)[0];
  const n = clause.split(/\s+/).length;
  const base = n >= 2 && n <= 9 ? clause : firstSentence.split(/\s+/).slice(0, 7).join(' ') + '…';
  const title = base.replace(/[,.;:!?]+$/, '');
  const year = settleDate(text, null);
  // Capitalised words that don't start a sentence and don't follow a place preposition — a rough name detector.
  const people = [...new Set([...text.matchAll(/(?<![.!?]\s)(?<!^)(?<!\b(?:in|to|from|at|near|of)\s)\b(?:Mr\.?\s|Mrs\.?\s)?([A-Z][a-z]{2,})\b/g)]
    .map(m => m[1]).filter(w => !STOP.has(w.toLowerCase()) && !/^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Sunday|God)$/.test(w)))]
    // A name the speaker corrected ("Ramesh, no sorry, Suresh" / "Ramesh, I mean Suresh" / "not Ramesh but Suresh") is dropped.
    .filter(w => !new RegExp(`\\b${w}\\b,?\\s+(?:no|nahi|sorry|i mean|actually)\\b|\\bnot ${w},?\\s+(?:but\\s+)?[a-z]`, 'i').test(text))
    .slice(0, 5);

  return {
    title: title || 'A memory',
    category,
    tags: tags.length ? tags : ['memory'],
    summary: text.length > 280 ? text.slice(0, 277) + '…' : text,
    memory_date: year,
    people_mentioned: people,
    sentiment: 'nostalgic'
  };
}

/** Rank memories by keyword overlap with the question. */
function rankMemories(question, memories, limit = 6) {
  const q = new Set(keywords(question));
  if (!q.size) return memories.slice(0, limit);
  return memories
    .map(m => {
      const hay = keywords(`${m.title} ${m.title} ${(m.tags || []).join(' ')} ${m.content}`);
      const score = hay.reduce((s, w) => s + (q.has(w) ? 1 : 0), 0);
      return { m, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.m);
}

// ── Public API ─────────────────────────────────────────────────
async function extractMemory(transcription, family = null) {
  const prompt = `You are analyzing a voice memo from an elderly person sharing a memory.

RAW TRANSCRIPTION:
"""${transcription}"""

Rules: never invent a year the speaker didn't say. If they sound unsure ("I think", "maybe", "or"), keep that uncertainty in memory_date.

Respond ONLY with valid JSON (no markdown):
{
  "title": "short memorable title (max 8 words)",
  "category": "one of: recipe, story, advice, event, family, place, other",
  "tags": ["3-5 short lowercase tags"],
  "summary": "2-3 sentence clean summary, written warmly in third person",
  "memory_date": "the date or period exactly as sure as the speaker was, e.g. \"1968\", \"around 1978\", \"1978 or 1979\", \"late 1970s\"; null if they never said when",
  "people_mentioned": ["names of people mentioned; if the speaker corrects a name (\"Ramesh, no, Suresh\"), only the corrected one"],
  "sentiment": "warm | happy | nostalgic | bittersweet | serious"
}`;

  const out = await generate(prompt, null, family);
  if (out?.text) {
    const match = out.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return { ...heuristicExtract(transcription), ...parsed, memory_date: settleDate(transcription, parsed.memory_date), engine: out.engine };
      } catch { /* fall through to heuristics */ }
    }
  }
  return { ...heuristicExtract(transcription), engine: 'heuristic' };
}

/**
 * The final say on a story's date, whatever model ran: only years the speaker actually said,
 * and their uncertainty kept ("I think it was 1978, or maybe 1979" → "1978 or 1979").
 */
const HEDGE = /\b(maybe|perhaps|i think|i guess|i believe|around|about|roughly|or so|probably|not sure|something like|could have been|might have been|circa)\b/i;
function settleDate(text, proposed) {
  const said = [...String(text).matchAll(/\b(1[89]\d\d|20\d\d)(s)?\b/g)].map(m => ({ year: m[1], decade: !!m[2], at: m.index, end: m.index + m[0].length }));
  const prop = proposed == null ? null : String(proposed).trim().slice(0, 40) || null;
  if (!said.length) return prop && /\d{4}/.test(prop) ? null : prop; // a year nobody said is dropped
  for (let i = 0; i + 1 < said.length; i++) {
    const between = text.slice(said[i].end, said[i + 1].at);
    if (said[i].year !== said[i + 1].year && between.length < 24 && /\b(or|to)\b|[-–]/i.test(between)) {
      return `${said[i].year} or ${said[i + 1].year}`;
    }
  }
  const first = said[0];
  const near = text.slice(Math.max(0, first.at - 40), first.end + 25);
  if (first.decade) return `the ${first.year}s`;
  if (HEDGE.test(near)) return `around ${first.year}`;
  // Keep the model's wording ("summer 1968") only if its year is one the speaker said.
  const propYear = prop?.match(/\b(1[89]\d\d|20\d\d)\b/)?.[1];
  return propYear && said.some(y => y.year === propYear) && !HEDGE.test(prop) ? prop : first.year;
}

async function answerQuestion(question, memories, personName = 'them', family = null) {
  const relevant = rankMemories(question, memories);
  const sources = relevant.map(m => ({ id: m.id, title: m.title }));

  if (!memories.length) {
    return { answer: `There are no memories saved for ${personName} yet. Record one first, then ask again.`, sources: [], engine: 'none' };
  }

  const context = (relevant.length ? relevant : memories.slice(0, 6))
    .map((m, i) => `[${i + 1}] ${m.title}${m.memory_date ? ` (${m.memory_date})` : ''}: ${m.content}`).join('\n\n');

  const system = `You answer family questions about ${personName}, using ONLY their recorded memories below.
Speak warmly, in the first person as ${personName}, as if they were telling it. Keep it under 4 sentences.
Use their exact details (quantities, names, places). If the memories don't contain the answer, say honestly
that ${personName} hasn't recorded that yet and suggest asking them about it.

MEMORIES:
${context}`;

  const out = await generate(`Question: ${question}`, system, family);
  if (out?.text) return { answer: out.text, sources, engine: out.engine };

  // No model: answer by quoting the most relevant memory verbatim — still truthful and useful.
  if (!relevant.length) {
    return { answer: `${personName} hasn't recorded anything about that yet. It might be a good question to ask them next time.`, sources: [], engine: 'heuristic' };
  }
  const top = relevant[0];
  return {
    answer: `Here's what ${personName} said in "${top.title}": “${top.content.length > 600 ? top.content.slice(0, 597) + '…' : top.content}”`,
    sources, engine: 'heuristic'
  };
}

async function generateLifeSummary(memories, personName = 'them', family = null) {
  if (!memories.length) return { summary: '', engine: 'none' };
  const list = memories.slice(0, 30).map(m => `- ${m.title}${m.memory_date ? ` (${m.memory_date})` : ''}: ${(m.content || '').slice(0, 200)}`).join('\n');
  const out = await generate(`These are memories recorded by ${personName}:\n${list}\n\nWrite a warm, honest two-paragraph tribute (max 120 words) to ${personName} that draws only on these memories. No invented facts.`, null, family);
  if (out?.text) return { summary: out.text, engine: out.engine };

  const cats = {};
  memories.forEach(m => { cats[m.category] = (cats[m.category] || 0) + 1; });
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c]) => c + (cats[c] > 1 ? 's' : ''));
  const titles = memories.slice(0, 4).map(m => `“${m.title}”`).join(', ');
  return {
    summary: `${personName} has shared ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} so far — mostly ${top.slice(0, 2).join(' and ')}. Among them: ${titles}. Each one is kept here, in their own words, for the family.`,
    engine: 'heuristic'
  };
}

async function checkHealth() {
  const or = openrouter.enabled(), tinker = !!(TINKER_KEY && TINKER_PATH);
  return {
    engine: or ? `openrouter:${openrouter.modelLabel()}` : tinker ? `tinker:${TINKER_LABEL}` : 'heuristic',
    openrouter: or,
    tinker,
    tinkerModel: tinker ? TINKER_LABEL : null
  };
}

/** The sentence(s) of a memory that best match a question — shown under answers as the exact words. */
function excerpt(memory, question, max = 220) {
  const q = new Set(keywords(question));
  const sentences = (memory.content || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return '';
  let best = 0, bestScore = -1;
  sentences.forEach((s, i) => {
    const score = keywords(s).reduce((n, w) => n + (q.has(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  let text = sentences[best];
  if (text.length < 90 && sentences[best + 1]) text += ' ' + sentences[best + 1];
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

module.exports = { settleDate, extractMemory, answerQuestion, generateLifeSummary, checkHealth, rankMemories, excerpt };
