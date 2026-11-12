/**
 * Checks every key in .env with a real, tiny call and prints ✅ / ❌. Never prints a secret
 * (only its last 4 characters). Run from the app folder:  node scripts/check-keys.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { configured } = require('../src/env');

const tail = v => (v ? `…${String(v).slice(-4)}` : 'missing');
const results = [];
const check = async (name, envs, fn) => {
  const missing = envs.filter(e => !configured(e));
  if (missing.length) return results.push(['⬜', name, `not set: ${missing.join(', ')}`]);
  try { results.push(['✅', name, (await fn()) || 'ok']); }
  catch (e) { results.push(['❌', name, String(e.message).slice(0, 140)]); }
};

(async () => {
  await check('Cloudflare R2 (audio storage)', ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'], async () => {
    const storage = require('../src/storage');
    const key = `healthcheck/${Date.now()}.txt`;
    await storage.put(key, Buffer.from('memoria'), 'text/plain');
    const url = await storage.signedGet(key, 60);
    const body = await (await fetch(url)).text();
    await storage.remove(key);
    if (body !== 'memoria') throw new Error('upload worked but the presigned read did not');
    return `upload, presigned read, delete all work (bucket ${process.env.R2_BUCKET || 'memoria-audio'}, key ${tail(process.env.R2_ACCESS_KEY_ID)})`;
  });

  await check('Groq Whisper (free transcription)', ['GROQ_API_KEY'], async () => {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
    if (!r.ok) throw new Error(`Groq said ${r.status}`);
    const ids = (await r.json()).data.map(m => m.id);
    if (!ids.some(id => /whisper/.test(id))) throw new Error('key works but no Whisper model is available');
    return `key ${tail(process.env.GROQ_API_KEY)} works, Whisper available`;
  });

  await check('Hugging Face (Gemma 4 overflow)', ['HF_TOKEN'], async () => {
    const hf = require('../src/hf');
    const out = await hf.complete('Reply with the single word: ok', null, { maxTokens: 5 });
    if (!out) throw new Error('call failed: the token needs "Make calls to Inference Providers"');
    return `token ${tail(process.env.HF_TOKEN)} works, ${out.engine}, this check cost $${out.usd.toFixed(6)}`;
  });

  await check('Gemini (main AI)', ['GEMINI_API_KEY'], async () => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    if (!r.ok) throw new Error(`Gemini said ${r.status}`);
    return 'key works';
  });

  console.log('\nMemoria key check\n');
  for (const [icon, name, note] of results) console.log(`${icon}  ${name.padEnd(34)} ${note}`);
  console.log('');
  process.exit(results.some(r => r[0] === '❌') ? 1 : 0);
})();
