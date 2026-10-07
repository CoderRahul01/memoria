/**
 * ElevenLabs Scribe — speech to text, word for word.
 * Memoria never speaks in a generated voice: "Listen" always plays the real recording.
 * Scribe gives us each word with its timing, so an answer can play the exact moment it was said.
 */

const fs = require('fs');
const { configured } = require('./env');

const BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = configured('ELEVENLABS_API_KEY');
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';

const enabled = () => !!API_KEY;

/** Returns { text, words: [{ text, start, end }], language } or null. */
async function transcribe(buffer, mime = 'audio/webm', filename = 'memory.webm') {
  if (!API_KEY) return null;
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false'); // their words only, no "(laughs)" markers
  form.append('file', new Blob([buffer], { type: mime }), filename);

  const res = await fetch(`${BASE}/speech-to-text`, {
    method: 'POST', headers: { 'xi-api-key': API_KEY }, body: form, signal: AbortSignal.timeout(180_000)
  });
  if (!res.ok) {
    console.error('ElevenLabs STT failed:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  const words = (data.words || [])
    .filter(w => w.type === 'word')
    .map(w => ({ text: w.text, start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 }));
  const text = data.text?.trim();
  return text ? { text, words, language: data.language_code || null } : null;
}

/** Back-compat helper for a multer file on disk. */
async function transcribeAudio(file) {
  return transcribe(fs.readFileSync(file.path), file.mimetype, file.originalname || 'memory.webm');
}

module.exports = { enabled, transcribe, transcribeAudio };
