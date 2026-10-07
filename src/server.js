/**
 * Express API Server — Memoria
 * Every request carries a private family key (X-Family-Key); all data is scoped to that family.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const gemma = require('./gemma');
const elevenlabs = require('./elevenlabs');
const backboard = require('./backboard');
const billing = require('./billing');
const credits = require('./credits');
const { configured } = require('./env');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(cors());

// ── Dodo webhook (needs the raw body for signature checks) ─────
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let event;
  try { event = billing.verify(req.body.toString('utf8'), req.headers); }
  catch (e) {
    console.warn('Webhook rejected:', e.message);
    return res.status(401).json({ error: 'invalid signature' });
  }
  try {
    const data = event.data || {};
    const familyId = data.metadata?.family_id;
    if (event.type === 'payment.succeeded' && familyId) {
      const fam = await db.markLifetime(familyId, { payment_id: data.payment_id, email: data.customer?.email });
      db.logEvent(familyId, 'purchase', { amount: data.total_amount, currency: data.currency, matched: !!fam });
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handling failed:', e);
    res.status(500).json({ error: 'webhook failed' });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const UPLOAD_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('audio/') || /\.(webm|mp4|mp3|wav|ogg|m4a)$/i.test(file.originalname))
});

const cleanup = (...files) => files.flat().filter(Boolean).forEach(f => fs.unlink(f.path, () => {}));
const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(err);
  db.logEvent(req.family?.id, 'error', { route: req.route?.path, message: String(err.message).slice(0, 160) }, null, false);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ── Family (private space) ─────────────────────────────────────
function deviceOf(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'phone';
  return 'computer';
}

async function requireFamily(req, res, next) {
  try {
    const family = await db.familyByKey(req.get('X-Family-Key'));
    if (!family) return res.status(401).json({ error: 'This family space was not found. Open your private link again.', code: 'no_family' });
    req.family = family;
    if (Date.now() - new Date(family.last_seen).getTime() > 60_000) db.touchFamily(family.id).catch(() => {});
    next();
  } catch (e) { next(e); }
}

const limitsFor = family => family.plan === 'lifetime'
  ? { persons: null, memories: null, voice: true, keepsake: true }
  : { ...billing.FREE_LIMITS, voice: false, keepsake: false };

const publicFamily = (f, counts = {}) => ({
  id: f.id.slice(0, 8), owner_name: f.owner_name, plan: f.plan, created_at: f.created_at,
  limits: limitsFor(f), ...counts,
  price: billing.PRICE_LABEL, can_buy: billing.enabled()
});

// Simple guard so one family can't burn through AI credits.
const aiUse = new Map();
function aiBudget(family) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const k = `${family.id}:${hour}`;
  const n = (aiUse.get(k) || 0) + 1;
  aiUse.set(k, n);
  if (aiUse.size > 5000) aiUse.clear();
  if (n > (family.plan === 'lifetime' ? 300 : 60)) throw httpError(429, 'That’s a lot in one hour. Take a short break and try again soon.');
}

app.post('/api/family', wrap(async (req, res) => {
  const { owner_name, timezone, language } = req.body || {};
  const { key, family } = await db.createFamily({
    owner_name: owner_name?.trim()?.slice(0, 40) || null,
    timezone: String(timezone || '').slice(0, 60) || null,
    language: String(language || '').slice(0, 20) || null,
    device: deviceOf(req.get('user-agent'))
  });
  db.logEvent(family.id, 'family_created', { device: family.device, timezone: family.timezone });
  res.json({ key, family: publicFamily(family, { memory_count: 0, person_count: 0 }) });
}));

app.use('/api', (req, res, next) => {
  if (['/health', '/family'].includes(req.path) && !(req.path === '/family' && req.method !== 'POST')) return next();
  return requireFamily(req, res, next);
});

app.get('/api/family', wrap(async (req, res) => {
  const [memory_count, persons] = await Promise.all([db.countMemories(req.family.id), db.getAllPersons(req.family.id)]);
  res.json(publicFamily(req.family, { memory_count, person_count: persons.length }));
}));

app.patch('/api/family', wrap(async (req, res) => {
  const f = await db.renameFamily(req.family.id, req.body.owner_name?.trim()?.slice(0, 40) || null);
  res.json(publicFamily(f));
}));

app.post('/api/presence', (req, res) => {
  const { view, person } = req.body || {};
  db.heartbeat(req.family.id, String(view || 'home').slice(0, 20), person ? String(person).slice(0, 40) : null);
  res.json({ ok: true });
});

const TRACKABLE = new Set(['view', 'prompt_used', 'listen', 'share_link', 'upgrade_viewed', 'print', 'export', 'onboarded']);
app.post('/api/track', (req, res) => {
  const { name, props } = req.body || {};
  if (TRACKABLE.has(name)) db.logEvent(req.family.id, name, typeof props === 'object' && props ? props : {});
  res.json({ ok: true });
});

app.post('/api/billing/checkout', wrap(async (req, res) => {
  if (!billing.enabled()) throw httpError(503, 'Lifetime isn’t available just yet.');
  db.logEvent(req.family.id, 'checkout_started', {});
  res.json({ url: billing.checkoutUrl(req.family) });
}));

// ── Backboard memory sync ─────────────────────────────────────
const assistantPromises = new Map();
const synced = new Set();
function assistantFor(familyId, personName) {
  if (!backboard.enabled()) return Promise.resolve(null);
  const key = `${familyId}:${personName}`;
  if (!assistantPromises.has(key)) {
    assistantPromises.set(key, (async () => {
      const person = await db.getPerson(familyId, personName) || await db.savePerson(familyId, { name: personName });
      if (person.backboard_assistant_id) return person.backboard_assistant_id;
      const id = await backboard.ensureAssistant(person);
      await db.updatePersonAssistant(familyId, personName, id);
      for (const m of (await db.getAllMemories(familyId, personName)).reverse()) {
        if (synced.has(m.id)) continue;
        synced.add(m.id);
        await backboard.addMemory(id, m).catch(e => { synced.delete(m.id); console.warn('Backboard backfill:', e.message); });
      }
      return id;
    })().catch(e => { assistantPromises.delete(key); throw e; }));
  }
  return assistantPromises.get(key);
}

function syncToBackboard(memory) {
  if (!backboard.enabled()) return;
  assistantFor(memory.family_id, memory.person_name)
    .then(id => {
      if (!id || synced.has(memory.id)) return;
      synced.add(memory.id);
      return backboard.addMemory(id, memory);
    })
    .catch(e => { synced.delete(memory.id); console.warn('Backboard sync failed:', e.message); });
}

async function voiceFor(familyId, personName) {
  const person = personName ? await db.getPerson(familyId, personName) : null;
  return person?.voice_id || null;
}

// Natural read-aloud voice is a Lifetime benefit; free families hear their device's voice.
async function speakable(family, text) {
  if (!elevenlabs.enabled() || family.plan !== 'lifetime') return false;
  if (await credits.allow('tts_chars', text.length, family)) return true;
  db.logEvent(family.id, 'credit_fallback', { kind: 'tts_chars' });
  return false;
}

async function tts(family, text, voiceId, key) {
  const url = await elevenlabs.textToSpeech(text, voiceId, key);
  if (url) credits.record(family.id, 'tts_chars', Math.min(text.length, 2500));
  return url;
}

async function queueTTS(family, memory) {
  try {
    if (!await speakable(family, memory.content)) return;
    const url = await tts(family, memory.content, await voiceFor(family.id, memory.person_name), memory.id);
    if (url) await db.updateMemoryTTS(memory.id, url);
  } catch (e) { console.warn('TTS failed:', e.message); }
}

async function checkMemoryLimit(family) {
  const lim = limitsFor(family);
  if (lim.memories && await db.countMemories(family.id) >= lim.memories) {
    throw httpError(402, `You’ve saved ${lim.memories} memories, the free limit. Unlock Lifetime to keep going.`, { code: 'limit' });
  }
}

async function createMemory(family, content, person_name, source) {
  aiBudget(family);
  await db.savePerson(family.id, { name: person_name });
  const t0 = Date.now();
  const extracted = await gemma.extractMemory(content, family);
  const memory = await db.saveMemory(family.id, {
    person_name, content, source,
    title: extracted.title, tags: extracted.tags, category: extracted.category,
    memory_date: extracted.memory_date, people: extracted.people_mentioned
  });
  db.logEvent(family.id, 'memory_saved', { source, engine: extracted.engine, chars: content.length }, Date.now() - t0);
  queueTTS(family, memory);
  if (await credits.allow('backboard', 0, family)) syncToBackboard(memory);
  return { ...memory, summary: extracted.summary };
}

// ── HEALTH ─────────────────────────────────────────────────────
app.get('/api/health', wrap(async (req, res) => {
  res.json({
    status: 'ok',
    ai: await gemma.checkHealth(),
    voice: elevenlabs.enabled(),
    payments: billing.enabled()
  });
}));

// ── PERSONS ────────────────────────────────────────────────────
app.get('/api/persons', wrap(async (req, res) => {
  res.json(await db.getAllPersons(req.family.id));
}));

app.post('/api/persons', wrap(async (req, res) => {
  const name = req.body.name?.trim()?.slice(0, 40);
  if (!name) throw httpError(400, 'Please enter a name.');
  const existing = await db.getPerson(req.family.id, name);
  if (existing) return res.json(existing);
  const lim = limitsFor(req.family);
  const count = (await db.getAllPersons(req.family.id)).length;
  if (lim.persons && count >= lim.persons) {
    throw httpError(402, 'The free plan keeps one person’s stories. Unlock Lifetime to add everyone in the family.', { code: 'limit' });
  }
  const person = await db.savePerson(req.family.id, { name, relationship: req.body.relationship?.trim()?.slice(0, 40) });
  db.logEvent(req.family.id, 'person_added', { relationship: person.relationship });
  res.json(person);
}));

// ── MEMORIES ───────────────────────────────────────────────────
app.get('/api/memories', wrap(async (req, res) => {
  const { person, q } = req.query;
  if (!person) return res.json([]);
  res.json(q ? await db.searchMemories(req.family.id, String(q).slice(0, 80), person) : await db.getAllMemories(req.family.id, person));
}));

app.get('/api/memories/:id', wrap(async (req, res) => {
  const memory = await db.getMemory(req.family.id, req.params.id);
  if (!memory) throw httpError(404, 'Memory not found');
  res.json(memory);
}));

app.delete('/api/memories/:id', wrap(async (req, res) => {
  const memory = await db.getMemory(req.family.id, req.params.id);
  if (!memory) throw httpError(404, 'Memory not found');
  await db.deleteMemory(req.family.id, req.params.id);
  if (memory.tts_url) fs.unlink(path.join(__dirname, '../public', memory.tts_url), () => {});
  db.logEvent(req.family.id, 'memory_deleted', {});
  res.json({ success: true });
}));

app.post('/api/memories', wrap(async (req, res) => {
  const content = req.body.content?.trim();
  if (!content) throw httpError(400, 'Write or say something first.');
  if (!req.body.person_name) throw httpError(400, 'Choose whose memory this is.');
  await checkMemoryLimit(req.family);
  const memory = await createMemory(req.family, content.slice(0, 8000), req.body.person_name, req.body.source === 'sample' ? 'sample' : 'typed');
  res.json({ success: true, memory });
}));

// Prefers ElevenLabs Scribe; falls back to the browser's live transcript.
app.post('/api/record', upload.single('audio'), wrap(async (req, res) => {
  try {
    await checkMemoryLimit(req.family);
    const browserText = req.body.transcription?.trim();
    let transcription = null;
    const t0 = Date.now();
    // Length of the recording: the browser reports it; otherwise estimate from size (~24 kbps Opus).
    const minutes = Math.max(0.1, Math.min(30, (Number(req.body.duration) || req.file?.size / 3000 || 0) / 60));
    if (req.file && elevenlabs.enabled()) {
      if (await credits.allow('stt_minutes', minutes, req.family)) {
        transcription = await elevenlabs.transcribeAudio(req.file).catch(e => (console.warn('STT:', e.message), null));
        if (transcription) credits.record(req.family.id, 'stt_minutes', minutes);
        db.logEvent(req.family.id, 'transcribed', { minutes: Math.round(minutes * 10) / 10 }, Date.now() - t0, !!transcription);
      } else {
        db.logEvent(req.family.id, 'credit_fallback', { kind: 'stt_minutes' });
      }
    }
    transcription = transcription || browserText;
    if (!transcription) {
      throw httpError(422, 'We couldn’t write out that recording right now. Please type the story in the box, then keep it.');
    }
    const memory = await createMemory(req.family, transcription.slice(0, 8000), req.body.person_name, 'voice');
    res.json({ success: true, memory });
  } finally {
    cleanup(req.file); // raw audio is never kept
  }
}));

// ── ASK ────────────────────────────────────────────────────────
app.post('/api/chat', wrap(async (req, res) => {
  const { question, person_name, speak } = req.body;
  if (!question?.trim()) throw httpError(400, 'Ask a question first.');
  if (!person_name) throw httpError(400, 'Choose whose stories to ask about.');
  aiBudget(req.family);

  const q = question.trim().slice(0, 400);
  const memories = await db.getAllMemories(req.family.id, person_name);
  const t0 = Date.now();
  let result = null;

  if (backboard.enabled() && memories.length && await credits.allow('backboard', 0, req.family)) {
    try {
      const assistantId = await assistantFor(req.family.id, person_name);
      const local = gemma.rankMemories(q, memories, 3);
      const context = local.map(m => `- ${m.title}${m.memory_date ? ` (${m.memory_date})` : ''}: ${m.content}`).join('\n');
      const r = await backboard.ask(assistantId, person_name, q, context, 15_000);
      if (r.text) {
        const hits = memories.filter(m => r.retrieved.some(t => t.includes(m.title) || t.includes(m.content.slice(0, 60))));
        const picked = [...new Map([...local.slice(0, 2), ...hits].map(m => [m.id, m])).values()].slice(0, 3);
        result = { answer: r.text, sources: picked, engine: r.engine };
      }
    } catch (e) {
      console.warn('Backboard ask failed, falling back:', e.message);
    }
  }
  if (!result) {
    const r = await gemma.answerQuestion(q, memories, person_name, req.family);
    result = { answer: r.answer, engine: r.engine, sources: r.sources.map(s => memories.find(m => m.id === s.id)).filter(Boolean) };
  }

  // Each source carries the exact words it came from, so families can check the answer.
  const sources = gemma.rankMemories(q, result.sources, 3).concat(result.sources).filter((m, i, a) => a.findIndex(x => x.id === m.id) === i)
    .slice(0, 3).map(m => ({ id: m.id, title: m.title, memory_date: m.memory_date, quote: gemma.excerpt(m, q) }));
  const grounded = gemma.rankMemories(q, memories, 1).length > 0;
  db.logEvent(req.family.id, 'question_asked', { engine: result.engine, sources: sources.length, grounded }, Date.now() - t0);

  let tts_url = null;
  if (speak && grounded && await speakable(req.family, result.answer)) {
    const v = await voiceFor(req.family.id, person_name);
    tts_url = await tts(req.family, result.answer, v, `chat_${crypto.randomUUID()}`).catch(() => null);
  }
  res.json({ answer: result.answer, sources: grounded ? sources : [], grounded, tts_url });
}));

// ── SPEAK A MEMORY ─────────────────────────────────────────────
app.post('/api/speak', wrap(async (req, res) => {
  const memory = req.body.memory_id ? await db.getMemory(req.family.id, req.body.memory_id) : null;
  if (!memory) throw httpError(404, 'Memory not found');
  db.logEvent(req.family.id, 'listen', {});
  if (memory.tts_url && fs.existsSync(path.join(__dirname, '../public', memory.tts_url))) return res.json({ tts_url: memory.tts_url });
  if (!await speakable(req.family, memory.content)) return res.json({ tts_url: null });
  const url = await tts(req.family, memory.content, await voiceFor(req.family.id, memory.person_name), memory.id);
  if (url) await db.updateMemoryTTS(memory.id, url);
  res.json({ tts_url: url });
}));

// ── VOICES ─────────────────────────────────────────────────────
app.get('/api/voices', (req, res) => {
  res.json({ enabled: elevenlabs.enabled(), default_voice_id: elevenlabs.DEFAULT_VOICE_ID, presets: elevenlabs.PRESET_VOICES });
});

app.post('/api/persons/:name/voice', wrap(async (req, res) => {
  const { voice_id } = req.body;
  if (!elevenlabs.PRESET_VOICES.some(v => v.id === voice_id)) throw httpError(400, 'Choose one of the reading voices.');
  await db.savePerson(req.family.id, { name: req.params.name });
  await db.updatePersonVoiceId(req.family.id, req.params.name, voice_id);
  res.json({ success: true, voice_id });
}));

app.post('/api/clone-voice', upload.array('samples', 10), wrap(async (req, res) => {
  try {
    if (!limitsFor(req.family).voice) throw httpError(402, 'Hearing stories in their own voice is part of Lifetime.', { code: 'limit' });
    const { person_name } = req.body;
    if (!person_name) throw httpError(400, 'Choose whose voice this is.');
    if (!req.files?.length) throw httpError(400, 'Add at least one recording of their voice.');
    if (!await credits.allow('voice_slots', 1, req.family)) {
      db.logEvent(req.family.id, 'credit_fallback', { kind: 'voice_slots' });
      throw httpError(409, 'Voice creation is fully booked right now. We’ve been notified and will open more space soon.');
    }
    const t0 = Date.now();
    const voice_id = await elevenlabs.cloneVoice(`${person_name} · ${req.family.id.slice(0, 8)}`, `Voice of ${person_name}, recorded by family in Memoria`, req.files);
    await db.savePerson(req.family.id, { name: person_name });
    await db.updatePersonVoiceId(req.family.id, person_name, voice_id, true);
    db.logEvent(req.family.id, 'voice_cloned', { samples: req.files.length }, Date.now() - t0);
    res.json({ success: true, voice_id });
  } finally {
    cleanup(req.files);
  }
}));

// ── LIFE STORY ─────────────────────────────────────────────────
app.get('/api/summary/:person_name', wrap(async (req, res) => {
  const memories = await db.getAllMemories(req.family.id, req.params.person_name);
  if (memories.length) aiBudget(req.family);
  const t0 = Date.now();
  const { summary, engine } = await gemma.generateLifeSummary(memories, req.params.person_name, req.family);
  if (memories.length) db.logEvent(req.family.id, 'tribute', { engine }, Date.now() - t0);
  res.json({ summary, memory_count: memories.length });
}));

// ── EXPORT (the family owns its data) ─────────────────────────
app.get('/api/export/:person_name', wrap(async (req, res) => {
  const name = req.params.person_name;
  const memories = await db.getAllMemories(req.family.id, name);
  db.logEvent(req.family.id, 'export', {});
  res.setHeader('Content-Disposition', `attachment; filename="memoria-${name.replace(/[^\w-]/g, '_')}.json"`);
  res.json({ person: name, exported_at: new Date().toISOString(), memories: memories.map(({ family_id, ...m }) => m) });
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

db.initDB().then(async () => {
  app.listen(PORT, async () => {
    const ai = await gemma.checkHealth();
    if (backboard.enabled()) { await backboard.discoverModel(); backboard.warm(); }
    credits.start();
    console.log(`\n🧠 Memoria running at http://localhost:${PORT}`);
    console.log(`🤖 AI engine: ${ai.engine}`);
    console.log(`🎙️  ElevenLabs: ${elevenlabs.enabled() ? 'on' : 'off (browser speech fallback)'}`);
    console.log(`💳 Payments: ${billing.enabled() ? 'on' : 'off'}\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

module.exports = app;
