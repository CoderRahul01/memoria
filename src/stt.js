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
  // Free families: Gemini writes the words (most accurate on Hindi in testing; Whisper misheard a year
  // as "1900"), Groq Whisper supplies when each word was said. Both run at once; either works alone.
  const [groq, gem] = await Promise.all([
    GROQ_KEY ? viaGroq(buffer, mime, filename).catch(e => (console.warn('Groq STT:', e.message), null)) : null,
    GEMINI_KEY && quota.allowModel(family) ? viaGemini(buffer, mime, seconds).catch(e => (console.warn('Gemini STT:', e.message), null)) : null
  ]);
  if (gem && groq?.words?.length) {
    return { text: gem.text, words: alignWords(gem.text, groq.words, seconds), language: groq.language || gem.language, engine: 'gemini+groq' };
  }
  if (gem) return { ...gem, engine: 'gemini' };
  if (groq) return { ...groq, engine: 'groq' };
  return null;
}

const norm = s => String(s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

/**
 * Put Whisper's timings onto Gemini's words. Words that match exactly become anchors (longest common
 * subsequence); words in between get times interpolated between their anchors. Long recordings fall
 * back to proportional placement to keep the work bounded.
 */
function alignWords(text, timed, seconds) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const T = timed.map(w => ({ ...w, n: norm(w.text) }));
  const A = tokens.map(norm);
  const n = A.length, m = T.length;
  if (!n || !m) return approxWords(text, seconds);
  const anchor = new Array(n).fill(-1);
  if (n * m <= 4_000_000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] && A[i] === T[j].n ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (A[i] && A[i] === T[j].n) { anchor[i] = j; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
  }
  const end = T[m - 1].end;
  const points = [{ i: -1, t: T[0].start }];
  anchor.forEach((j, i) => { if (j >= 0) points.push({ i, t: T[j].start, e: T[j].end }); });
  points.push({ i: n, t: end });
  const out = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k], b = points[k + 1];
    if (a.i >= 0) out.push({ text: tokens[a.i], start: round(a.t), end: round(a.e) });
    const gap = b.i - a.i - 1;
    const from = a.i >= 0 ? a.e : a.t;
    for (let g = 1; g <= gap; g++) {
      const s = from + ((b.t - from) * (g - 1)) / gap, e = from + ((b.t - from) * g) / gap;
      out.push({ text: tokens[a.i + g], start: round(s), end: round(e), approx: true });
    }
  }
  return out;
}

module.exports = { transcribe, enabled, approxWords, alignWords };
