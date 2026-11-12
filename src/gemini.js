/**
 * Google Gemini API integration (Free Tier via Google AI Studio).
 * Provides lightning-fast, highly accurate structured extraction, summaries, and grounded Q&A.
 */

const { configured } = require('./env');

const GEMINI_KEY = configured('GEMINI_API_KEY');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const enabled = () => !!GEMINI_KEY;

/**
 * Generate text using Google Gemini
 * @param {string} prompt
 * @param {string|null} system
 * @param {{ thinking?: number, json?: boolean }} [opts] thinking budget in tokens (2.5 models, default 0); json forces a JSON reply
 * @returns {Promise<{ text: string, engine: string } | null>}
 */
async function generate(prompt, system = null, { thinking = null, json = false } = {}) {
  if (!enabled()) return null;

  const url = `${BASE_URL}/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  
  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      // Short, checkable tasks (filing, quoting, suggesting questions): thinking adds seconds, not accuracy.
      // Every quote is verified against the transcript afterwards anyway. GEMINI_THINKING_BUDGET overrides.
      ...(/2\.5/.test(MODEL) ? { thinkingConfig: { thinkingBudget: thinking ?? Number(process.env.GEMINI_THINKING_BUDGET ?? 0) } } : {})
    }
  };

  if (system) {
    body.systemInstruction = {
      parts: [{ text: system }]
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });

    if (!res.ok) {
      console.warn(`Gemini API error ${res.status}:`, (await res.text()).slice(0, 200));
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!text) return null;

    return { text, engine: `gemini:${MODEL}` };
  } catch (err) {
    console.warn('Gemini generate error:', err.message);
    return null;
  }
}

module.exports = {
  enabled,
  generate,
  modelLabel: () => MODEL
};

