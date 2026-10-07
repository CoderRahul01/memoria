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
const recordings = require('./recordings');
const { configured } = require('./env');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.disable('x-powered-by');

// Only Memoria's own sites may call the API from a browser.
const ORIGINS = new Set(['https://memoria-family.vercel.app', 'https://memoria-web-ten.vercel.app',
  'https://memoria-qlji.onrender.com', 'http://localhost:3000',
  ...(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ORIGINS.has(origin)) }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()'
  });
  next();
});

// Simple per-IP rate limits (one Render instance, so memory is enough).
const hits = new Map();
function limit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now > h.reset) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) {
      res.set('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    if (hits.size > 20_000) hits.clear();
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60_000).unref();
app.use('/api', limit('api', 300, 60_000));
app.post('/api/family', limit('family', 12, 3_600_000));

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
  ? { persons: null, memories: null, record_minutes: 30, keepsake: true }
  : { ...billing.FREE_LIMITS, record_minutes: 10, keepsake: false };

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
  if (req.path.startsWith('/audio/') && req.method === 'GET') return next();
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

const TRACKABLE = new Set(['view', 'prompt_used', 'clip_played', 'share_link', 'upgrade_viewed', 'print', 'export', 'onboarded']);
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
  if (await credits.allow('backboard', 0, family)) syncToBackboard(memory);
  return { ...memory, summary: extracted.summary };
}

// ── HEALTH ─────────────────────────────────────────────────────
app.get('/api/health', wrap(async (req, res) => {
  res.json({
    status: 'ok',
    ai: await gemma.checkHealth(),
    transcription: elevenlabs.enabled(),
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

// Keeps the real recording. Scribe writes it out word for word (with timings); the browser's
// live transcript is the fallback, and the family's own corrections always win.
app.post('/api/record', upload.single('audio'), wrap(async (req, res) => {
  try {
    if (!req.file) throw httpError(400, 'No recording arrived. Please try again.');
    if (!req.body.person_name) throw httpError(400, 'Choose whose memory this is.');
    await checkMemoryLimit(req.family);
    const lim = limitsFor(req.family);
    const buffer = fs.readFileSync(req.file.path);
    // Length: the browser reports it; otherwise estimate from size (~32 kbps Opus).
    const seconds = Math.max(1, Number(req.body.duration) || buffer.length / 4000);
    if (seconds > lim.record_minutes * 60 + 15) {
      throw httpError(413, req.family.plan === 'lifetime'
        ? 'That recording is over 30 minutes. Please split it into shorter stories.'
        : 'Free recordings can be up to 10 minutes. Split it into two stories, or unlock Lifetime for 30-minute recordings.');
    }
    const minutes = seconds / 60;
    const typed = req.body.transcription?.trim();
    const edited = req.body.edited === 'true';
    let heard = null;
    const t0 = Date.now();
    if (elevenlabs.enabled()) {
      if (await credits.allow('stt_minutes', minutes, req.family)) {
        heard = await elevenlabs.transcribe(buffer, req.file.mimetype, req.file.originalname).catch(e => (console.warn('STT:', e.message), null));
        if (heard) credits.record(req.family.id, 'stt_minutes', minutes);
        db.logEvent(req.family.id, 'transcribed', { minutes: Math.round(minutes * 10) / 10, language: heard?.language }, Date.now() - t0, !!heard);
      } else {
        db.logEvent(req.family.id, 'credit_fallback', { kind: 'stt_minutes' });
      }
    }
    const content = (edited && typed) || heard?.text || typed;
    if (!content) {
      throw httpError(422, 'We couldn’t write out that recording right now. Please type what was said in the box, then keep it.');
    }
    const memory = await createMemory(req.family, content.slice(0, 8000), req.body.person_name, 'voice');

    const mb = buffer.length / 1048576;
    let kept = false;
    if (await credits.allow('storage_mb', mb, req.family)) {
      await recordings.save(memory.id, req.family.id, {
        buffer, mime: req.file.mimetype || 'audio/webm', duration: seconds, words: heard?.words, language: heard?.language
      });
      kept = true;
    } else {
      db.logEvent(req.family.id, 'credit_fallback', { kind: 'storage_mb' });
    }
    res.json({ success: true, memory: { ...memory, has_voice: kept, voice_seconds: kept ? seconds : null }, voice_kept: kept });
  } finally {
    cleanup(req.file); // the temp file goes; the recording itself lives in the database
  }
}));

// ── ASK ────────────────────────────────────────────────────────
app.post('/api/chat', wrap(async (req, res) => {
  const { question, person_name } = req.body;
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
  const picked = gemma.rankMemories(q, result.sources, 3).concat(result.sources).filter((m, i, a) => a.findIndex(x => x.id === m.id) === i).slice(0, 3);
  const spoken = new Map((await recordings.getWords(picked.map(m => m.id))).map(r => [r.memory_id, r]));
  const sources = picked.map(m => {
    const quote = gemma.excerpt(m, q);
    const rec = spoken.get(m.id);
    const clip = rec ? recordings.clipFor(rec.words, quote) : null;
    return {
      id: m.id, title: m.title, memory_date: m.memory_date, quote,
      voice: rec ? { url: recordings.signedUrl(m.id), start: clip?.start ?? 0, end: clip?.end ?? null } : null
    };
  });
  const grounded = gemma.rankMemories(q, memories, 1).length > 0;
  db.logEvent(req.family.id, 'question_asked', { engine: result.engine, sources: sources.length, grounded }, Date.now() - t0);

  res.json({ answer: result.answer, sources: grounded ? sources : [], grounded });
}));

// ── LISTEN: only ever the real recording ──────────────────────
app.get('/api/memories/:id/voice', wrap(async (req, res) => {
  const memory = await db.getMemory(req.family.id, req.params.id);
  if (!memory) throw httpError(404, 'Memory not found');
  if (!memory.has_voice) throw httpError(404, 'This story was typed, so there’s no recording of it.');
  db.logEvent(req.family.id, 'listen', {});
  res.json({ url: recordings.signedUrl(memory.id), seconds: memory.voice_seconds });
}));

app.get('/api/persons/:name/voice', wrap(async (req, res) => {
  const v = await db.voiceMinutes(req.family.id, req.params.name);
  res.json({ minutes: Math.round(Number(v?.minutes || 0) * 10) / 10, recordings: v?.n || 0 });
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

// ── AUDIO: signed, short-lived links; supports seeking (Range) ──
app.get('/api/audio/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (!recordings.verify(id, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'This link has expired. Open the story again.' });
  const rec = await recordings.getAudio(id);
  if (!rec) return res.status(404).end();
  const total = rec.audio.length;
  res.set({ 'Content-Type': rec.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? total - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : total - 1;
    if (start < 0 || start >= total || end < start) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    end = Math.min(end, total - 1);
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    return res.end(rec.audio.subarray(start, end + 1));
  }
  res.set('Content-Length', total).end(rec.audio);
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

db.initDB().then(async () => {
  app.listen(PORT, async () => {
    const ai = await gemma.checkHealth();
    if (backboard.enabled()) { await backboard.discoverModel(); backboard.warm(); }
    credits.start();
    console.log(`\n🧠 Memoria running at http://localhost:${PORT}`);
    console.log(`🤖 AI engine: ${ai.engine}`);
    console.log(`🎙️  Transcription: ${elevenlabs.enabled() ? 'ElevenLabs Scribe' : 'browser only'}`);
    console.log(`💳 Payments: ${billing.enabled() ? 'on' : 'off'}\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

module.exports = app;
