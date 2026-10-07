/**
 * Express API Server — Memoria
 * Routes: health, persons, memories, record, chat, speak, clone-voice, summary, export
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const gemma = require('./gemma');
const elevenlabs = require('./elevenlabs');
const backboard = require('./backboard');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const UPLOAD_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('audio/') || /\.(webm|mp4|mp3|wav|ogg|m4a)$/i.test(file.originalname))
});

const cleanup = (...files) => files.flat().filter(Boolean).forEach(f => fs.unlink(f.path, () => {}));
const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Something went wrong' });
});

function voiceFor(personName) {
  const person = personName ? db.getPerson(personName) : null;
  return person?.voice_id || null;
}

// Generate a memory's audio in the background so saving never waits on TTS.
function queueTTS(memory, text) {
  if (!elevenlabs.enabled()) return;
  elevenlabs.textToSpeech(text, voiceFor(memory.person_name), memory.id)
    .then(url => url && db.updateMemoryTTS(memory.id, url))
    .catch(e => console.warn('TTS failed:', e.message));
}

// ── Backboard memory sync ─────────────────────────────────────
// Each person has a Backboard assistant; every memory is mirrored into its memory store.
const assistantPromises = new Map();
const synced = new Set(); // memory ids already mirrored (this process)
function assistantFor(personName) {
  if (!backboard.enabled()) return Promise.resolve(null);
  if (!assistantPromises.has(personName)) {
    assistantPromises.set(personName, (async () => {
      const person = db.getPerson(personName) || db.savePerson({ name: personName });
      if (person.backboard_assistant_id) return person.backboard_assistant_id;
      const id = await backboard.ensureAssistant(person);
      db.updatePersonAssistant(personName, id);
      // Backfill memories saved before Backboard was switched on.
      for (const m of db.getAllMemories(personName).reverse()) {
        if (synced.has(m.id)) continue;
        synced.add(m.id);
        await backboard.addMemory(id, m).catch(e => { synced.delete(m.id); console.warn('Backboard backfill:', e.message); });
      }
      return id;
    })().catch(e => { assistantPromises.delete(personName); throw e; }));
  }
  return assistantPromises.get(personName);
}

function syncToBackboard(memory) {
  if (!backboard.enabled()) return;
  assistantFor(memory.person_name)
    .then(id => {
      if (!id || synced.has(memory.id)) return; // already included by a backfill
      synced.add(memory.id);
      return backboard.addMemory(id, memory);
    })
    .catch(e => { synced.delete(memory.id); console.warn('Backboard sync failed:', e.message); });
}

async function createMemory(content, person_name) {
  const extracted = await gemma.extractMemory(content);
  const memory = db.saveMemory({
    person_name,
    title: extracted.title,
    content,
    tags: extracted.tags,
    category: extracted.category,
    memory_date: extracted.memory_date,
    people: extracted.people_mentioned
  });
  queueTTS(memory, content);
  syncToBackboard(memory);
  return { ...memory, summary: extracted.summary, people_mentioned: extracted.people_mentioned, engine: extracted.engine };
}

// ── HEALTH ─────────────────────────────────────────────────────
app.get('/api/health', wrap(async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ai: await gemma.checkHealth(),
    voice: elevenlabs.enabled(),
    default_voice: elevenlabs.DEFAULT_VOICE_ID,
    backboard: backboard.enabled() ? backboard.modelLabel() : null
  });
}));

// ── PERSONS ────────────────────────────────────────────────────
app.get('/api/persons', (req, res) => {
  const persons = db.getAllPersons().map(p => ({ ...p, memory_count: db.getAllMemories(p.name).length }));
  res.json(persons);
});

app.post('/api/persons', (req, res) => {
  const { name, relationship, avatar_color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Please enter a name.' });
  const existing = db.getPerson(name.trim());
  if (existing) return res.json(existing);
  res.json(db.savePerson({ name: name.trim(), relationship, avatar_color }));
});

// ── MEMORIES ───────────────────────────────────────────────────
app.get('/api/memories', (req, res) => {
  const { person, q } = req.query;
  res.json(q ? db.searchMemories(q, person) : db.getAllMemories(person));
});

app.get('/api/memories/:id', (req, res) => {
  const memory = db.getMemory(req.params.id);
  if (!memory) return res.status(404).json({ error: 'Memory not found' });
  res.json(memory);
});

app.delete('/api/memories/:id', (req, res) => {
  const memory = db.getMemory(req.params.id);
  if (!memory) return res.status(404).json({ error: 'Memory not found' });
  db.deleteMemory(req.params.id);
  if (memory.tts_url) fs.unlink(path.join(__dirname, '../public', memory.tts_url), () => {});
  res.json({ success: true });
});

app.post('/api/memories', wrap(async (req, res) => {
  const content = req.body.content?.trim();
  if (!content) return res.status(400).json({ error: 'Write or say something first.' });
  const memory = await createMemory(content, req.body.person_name || 'Grandpa');
  res.json({ success: true, memory });
}));

// ── VOICE RECORDING → MEMORY ──────────────────────────────────
// Prefers server-side ElevenLabs Scribe (accurate, multilingual); falls back to the
// browser's live transcript so the flow works without any API key.
app.post('/api/record', upload.single('audio'), wrap(async (req, res) => {
  const browserText = req.body.transcription?.trim();
  let transcription = null, stt = 'browser';

  try {
    if (req.file && elevenlabs.enabled()) {
      transcription = await elevenlabs.transcribeAudio(req.file).catch(e => (console.warn('STT:', e.message), null));
      if (transcription) stt = 'elevenlabs-scribe';
    }
    transcription = transcription || browserText;
    if (!transcription) {
      return res.status(422).json({
        error: "We couldn't hear any words in that recording. Try again a little closer to the mic, or type the memory instead."
      });
    }
    const memory = await createMemory(transcription, req.body.person_name || 'Grandpa');
    res.json({ success: true, memory, stt });
  } finally {
    cleanup(req.file); // raw audio is never kept, for privacy
  }
}));

// ── ASK ────────────────────────────────────────────────────────
app.post('/api/chat', wrap(async (req, res) => {
  const { question, person_name, speak } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Ask a question first.' });

  const name = person_name || 'Grandpa';
  const memories = db.getAllMemories(name);
  let result = null;

  // 1st choice: Backboard — Gemma + the family's memory store, one API key.
  if (backboard.enabled() && memories.length) {
    try {
      const assistantId = await assistantFor(name);
      const local = gemma.rankMemories(question, memories, 3);
      const context = local.map(m => `- ${m.title}${m.memory_date ? ` (${m.memory_date})` : ''}: ${m.content}`).join('\n');
      const r = await backboard.ask(assistantId, name, question.trim(), context);
      if (r.text) {
        // Sources: memories Backboard retrieved, plus our own top match.
        const hits = memories.filter(m => r.retrieved.some(t => t.includes(m.title) || t.includes(m.content.slice(0, 60))));
        const sources = [...new Map([...hits, ...local.slice(0, 1)].map(m => [m.id, { id: m.id, title: m.title }])).values()];
        result = { answer: r.text, sources, engine: r.engine };
      }
    } catch (e) {
      console.warn('Backboard ask failed, falling back:', e.message);
    }
  }
  result ||= await gemma.answerQuestion(question.trim(), memories, name);

  let tts_url = null;
  if (speak && elevenlabs.enabled() && result.sources.length) {
    tts_url = await elevenlabs.textToSpeech(result.answer, voiceFor(person_name), `chat_${Date.now()}`).catch(() => null);
  }
  res.json({ ...result, tts_url });
}));

// ── SPEAK A MEMORY ─────────────────────────────────────────────
app.post('/api/speak', wrap(async (req, res) => {
  const { memory_id } = req.body;
  const memory = memory_id ? db.getMemory(memory_id) : null;
  if (!memory) return res.status(404).json({ error: 'Memory not found' });
  if (memory.tts_url && fs.existsSync(path.join(__dirname, '../public', memory.tts_url))) {
    return res.json({ tts_url: memory.tts_url });
  }
  if (!elevenlabs.enabled()) return res.json({ tts_url: null, fallback: 'browser' });

  const url = await elevenlabs.textToSpeech(memory.content, voiceFor(memory.person_name), memory.id);
  if (url) db.updateMemoryTTS(memory.id, url);
  res.json({ tts_url: url, fallback: url ? null : 'browser' });
}));

// ── VOICES & STORYTELLER PRESETS ──────────────────────────────
app.get('/api/voices', (req, res) => {
  res.json({
    enabled: elevenlabs.enabled(),
    default_voice_id: elevenlabs.DEFAULT_VOICE_ID,
    presets: elevenlabs.PRESET_VOICES
  });
});

app.post('/api/persons/:name/voice', (req, res) => {
  const { voice_id } = req.body;
  if (!voice_id) return res.status(400).json({ error: 'voice_id required' });
  const name = req.params.name;
  const person = db.getPerson(name) || db.savePerson({ name });
  db.updatePersonVoiceId(name, voice_id);
  res.json({ success: true, person_name: name, voice_id });
});

// ── KNOWLEDGE GRAPH & ENTITY RELATIONSHIPS (GEO / Cognee Prep) ─
app.get('/api/knowledge-graph/:person_name', (req, res) => {
  const name = req.params.person_name;
  const memories = db.getAllMemories(name);
  const nodes = [{ id: name, type: 'person', label: name, root: true }];
  const links = [];
  const entityMap = new Map();

  memories.forEach(m => {
    const memoryNodeId = `mem_${m.id}`;
    nodes.push({ id: memoryNodeId, type: 'memory', label: m.title, category: m.category, date: m.memory_date });
    links.push({ source: name, target: memoryNodeId, relation: 'remembers' });

    (m.tags || []).forEach(tag => {
      const tagId = `tag_${tag.toLowerCase()}`;
      if (!entityMap.has(tagId)) {
        entityMap.set(tagId, true);
        nodes.push({ id: tagId, type: 'tag', label: `#${tag}` });
      }
      links.push({ source: memoryNodeId, target: tagId, relation: 'tagged_with' });
    });

    (m.people || []).forEach(p => {
      const pId = `person_${p.toLowerCase()}`;
      if (!entityMap.has(pId)) {
        entityMap.set(pId, true);
        nodes.push({ id: pId, type: 'entity_person', label: p });
      }
      links.push({ source: memoryNodeId, target: pId, relation: 'mentions' });
    });
  });

  res.json({ person: name, memory_count: memories.length, nodes, links });
});

// ── VOICE CLONING ──────────────────────────────────────────────
app.post('/api/clone-voice', upload.array('samples', 10), wrap(async (req, res) => {
  try {
    const { person_name } = req.body;
    if (!person_name) return res.status(400).json({ error: 'Choose who this voice belongs to.' });
    if (!req.files?.length) return res.status(400).json({ error: 'Add at least one voice sample.' });
    const voice_id = await elevenlabs.cloneVoice(person_name, `Voice of ${person_name}, recorded by family in Memoria`, req.files);
    db.updatePersonVoiceId(person_name, voice_id);
    res.json({ success: true, voice_id });
  } finally {
    cleanup(req.files);
  }
}));

// ── LIFE STORY ─────────────────────────────────────────────────
app.get('/api/summary/:person_name', wrap(async (req, res) => {
  const memories = db.getAllMemories(req.params.person_name);
  const { summary, engine } = await gemma.generateLifeSummary(memories, req.params.person_name);
  res.json({ summary, engine, memory_count: memories.length });
}));

// ── EXPORT (the family owns its data) ─────────────────────────
app.get('/api/export/:person_name', (req, res) => {
  const name = req.params.person_name;
  const memories = db.getAllMemories(name);
  res.setHeader('Content-Disposition', `attachment; filename="memoria-${name.replace(/[^\w-]/g, '_')}.json"`);
  res.json({ person: db.getPerson(name), exported_at: new Date().toISOString(), memories });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

db.initDB().then(async () => {
  app.listen(PORT, async () => {
    const ai = await gemma.checkHealth();
    if (backboard.enabled()) await backboard.discoverModel();
    console.log(`\n🧠 Memoria running at http://localhost:${PORT}`);
    console.log(`🤖 AI engine: ${ai.engine}`);
    console.log(`🎙️  ElevenLabs: ${elevenlabs.enabled() ? 'on' : 'off (browser speech fallback)'}`);
    console.log(`🧩 Backboard: ${backboard.enabled() ? 'on — ' + backboard.modelLabel() : 'off'}\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

module.exports = app;
