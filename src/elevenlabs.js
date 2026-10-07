/**
 * ElevenLabs integration:
 * 1. Text-to-Speech (optionally in a cloned voice)
 * 2. Instant voice cloning from uploaded samples
 * 3. Speech-to-Text (Scribe)
 * Uses Node's built-in fetch / FormData / Blob.
 */

const path = require('path');
const fs = require('fs');
const { configured } = require('./env');

const BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = configured('ELEVENLABS_API_KEY');
// Default to Grandma Clo (warm elderly storyteller) or configured ELEVENLABS_VOICE_ID
const DEFAULT_VOICE_ID = configured('ELEVENLABS_VOICE_ID') || 'EMuO6fFLrXKOryHzij6K'; 
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';

const PRESET_VOICES = [
  { id: 'EMuO6fFLrXKOryHzij6K', name: 'Grandma Clo', tag: 'Elderly Storyteller', description: 'Warm, maternal elder with nostalgic warmth & gentle pace' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'Grandpa George', tag: 'Kind Grandfather', description: 'Calm, comforting grandfather cadence' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Uncle Arnold', tag: 'Reflective Elder', description: 'Clear, seasoned, classic memoir narration' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', tag: 'Classic Narrator', description: 'Steady, neutral voice for archive readings' }
];

const AUDIO_DIR = path.join(__dirname, '../public/audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const enabled = () => !!API_KEY;

function fileBlob(filePath, type = 'audio/webm') {
  return new Blob([fs.readFileSync(filePath)], { type });
}

/** Returns a public URL to an mp3, or null if TTS is unavailable. */
async function textToSpeech(text, voiceId, key) {
  if (!API_KEY || !text) return null;
  const res = await fetch(`${BASE}/text-to-speech/${voiceId || DEFAULT_VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: text.slice(0, 2500),
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.6, similarity_boost: 0.85, style: 0.25, use_speaker_boost: true }
    })
  });
  if (!res.ok) {
    console.error('ElevenLabs TTS error:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const filename = `tts_${String(key || Date.now()).replace(/[^\w-]/g, '')}.mp3`;
  fs.writeFileSync(path.join(AUDIO_DIR, filename), Buffer.from(await res.arrayBuffer()));
  return `/audio/${filename}`;
}

async function cloneVoice(name, description, files) {
  if (!API_KEY) throw new Error('Voice cloning needs ELEVENLABS_API_KEY on the server.');
  const form = new FormData();
  form.append('name', name);
  form.append('description', description || `Voice of ${name}`);
  for (const f of files) form.append('files', fileBlob(f.path, f.mimetype), f.originalname || 'sample.webm');

  const res = await fetch(`${BASE}/voices/add`, { method: 'POST', headers: { 'xi-api-key': API_KEY }, body: form });
  if (!res.ok) throw new Error(`Voice cloning failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).voice_id;
}

async function transcribeAudio(file) {
  if (!API_KEY) return null;
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('file', fileBlob(file.path, file.mimetype), file.originalname || 'memory.webm');

  const res = await fetch(`${BASE}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': API_KEY }, body: form });
  if (!res.ok) {
    console.error('ElevenLabs STT failed:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  return data.text?.trim() || null;
}

module.exports = { enabled, textToSpeech, cloneVoice, transcribeAudio, PRESET_VOICES, DEFAULT_VOICE_ID };
