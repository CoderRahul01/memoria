/**
 * Speech to text, with a chain of providers so a family's recording is always written out:
 *   1. ElevenLabs Scribe   word timings, best quality       (paid credits, kept within a monthly budget)
 *   2. Groq Whisper        word timings, generous free tier  GROQ_API_KEY
 *   3. Gemini              plain transcript, timings estimated from the audio length (same key as the AI)
 * The browser's live transcript and the family's own corrections still win over all of these.
 */
const { configured } = require('./env');
const elevenlabs = require('./elevenlabs');
const credits = require('./credits');
const quota = require('./quota');

const GROQ_KEY = configured('GROQ_API_KEY');
const GROQ_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const GEMINI_KEY = configured('GEMINI_API_KEY');
const GEMINI_STT_MODEL = process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash-lite';

const round = n => Math.round(n * 100) / 100;

async function viaGroq(buffer, mime, filename) {
  const form = new FormData();
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('temperature', '0');
  form.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form, signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const text = String(data.text || '').trim();
  if (!text) return null;
  const words = (data.words || []).map(w => ({ text: String(w.word).trim(), start: round(w.start), end: round(w.end) })).filter(w => w.text);
  return { text, words, language: data.language ? String(data.language).toLowerCase().slice(0, 20) : null };
}

/**
 * Spread a sentence's duration over its words by length. Good to about a second, which is enough for
 * "hear the moment" with a little padding. Marked approx so we never present it as exact.
 */
function approxWords(text, seconds) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  if (!tokens.length || !(seconds > 0)) return [];
  const weights = tokens.map(t => t.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return tokens.map((tok, i) => {
    const d = (weights[i] / total) * seconds;
    const w = { text: tok, start: round(t), end: round(t + d), approx: true };
    t += d;
    return w;
  });
}

async function viaGemini(buffer, mime, seconds) {
  // Plain transcription only: asking for timestamps made the model "hear" a different year in testing.
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_STT_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: (mime || 'audio/webm').split(';')[0], data: buffer.toString('base64') } },
        { text: 'Transcribe this recording word for word, in the language and script it is spoken in. Do not translate, summarise or correct anything. Output only the transcript.' }
      ] }],
      generationConfig: { temperature: 0, ...(/2\.5/.test(GEMINI_STT_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) }
    }),
    signal: AbortSignal.timeout(90_000)
  });
  if (!res.ok) throw new Error(`Gemini STT ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) return null;
  const hindi = /[ऀ-ॿ]/.test(text);
  return { text, words: approxWords(text, seconds), language: hindi ? 'hin' : null };
}

const enabled = () => elevenlabs.enabled() || !!GROQ_KEY || !!GEMINI_KEY;

/** Returns { text, words, language, engine } or null. Never throws. */
async function transcribe(buffer, mime, filename, { seconds, family } = {}) {
  const minutes = (seconds || buffer.length / 4000) / 60;
  const scribeOk = family?.plan === 'lifetime' || process.env.SCRIBE_FOR_FREE === '1';
  if (scribeOk && elevenlabs.enabled() && await credits.allow('stt_minutes', minutes, family)) {
    const heard = await elevenlabs.transcribe(buffer, mime, filename).catch(e => (console.warn('Scribe:', e.message), null));
    if (heard) { credits.record(family?.id, 'stt_minutes', minutes); return { ...heard, engine: 'scribe' }; }
  }
  if (GROQ_KEY) {
    const heard = await viaGroq(buffer, mime, filename).catch(e => (console.warn('Groq STT:', e.message), null));
    if (heard) return { ...heard, engine: 'groq' };
  }
  if (GEMINI_KEY && quota.allowModel(family)) {
    const heard = await viaGemini(buffer, mime, seconds).catch(e => (console.warn('Gemini STT:', e.message), null));
    if (heard) return { ...heard, engine: 'gemini' };
  }
  return null;
}

module.exports = { transcribe, enabled, approxWords };
