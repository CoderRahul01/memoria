/**
 * Database layer using sql.js (pure JS/WASM SQLite — no native compilation needed)
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'memoria.db');
let db = null;

// ── Core helpers ───────────────────────────────
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  setupSchema();
  return db;
}

function persist() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── Schema ─────────────────────────────────────
function setupSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      person_name TEXT NOT NULL DEFAULT 'Grandpa',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      category TEXT DEFAULT 'story',
      audio_url TEXT,
      tts_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      memory_date TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS persons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      relationship TEXT,
      voice_id TEXT,
      avatar_color TEXT DEFAULT '#F59E0B',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: people mentioned in each memory (added after first release)
  const cols = getAll('PRAGMA table_info(memories)').map(c => c.name);
  if (!cols.includes('people')) db.run(`ALTER TABLE memories ADD COLUMN people TEXT DEFAULT '[]'`);
  const pcols = getAll('PRAGMA table_info(persons)').map(c => c.name);
  if (!pcols.includes('backboard_assistant_id')) db.run('ALTER TABLE persons ADD COLUMN backboard_assistant_id TEXT');

  // Seed default person
  const count = getOne('SELECT COUNT(*) as cnt FROM persons');
  if (!count || count.cnt === 0) {
    db.run(
      `INSERT INTO persons (id, name, relationship, avatar_color) VALUES (?, ?, ?, ?)`,
      [uuidv4(), 'Grandpa', 'grandfather', '#F59E0B']
    );
    persist();
  }
}

// ── Memory operations ──────────────────────────
function saveMemory(data) {
  const id = uuidv4();
  const tags = JSON.stringify(data.tags || []);
  run(
    `INSERT INTO memories (id, person_name, title, content, tags, category, audio_url, tts_url, memory_date, people)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.person_name || 'Grandpa', data.title, data.content, tags,
     data.category || 'story', data.audio_url || null, data.tts_url || null, data.memory_date || null,
     JSON.stringify(data.people || [])]
  );
  return getMemory(id);
}

function getMemory(id) {
  const m = getOne('SELECT * FROM memories WHERE id = ?', [id]);
  if (m) { m.tags = JSON.parse(m.tags || '[]'); m.people = JSON.parse(m.people || '[]'); }
  return m;
}

function getAllMemories(personName) {
  const rows = personName
    ? getAll('SELECT * FROM memories WHERE person_name = ? ORDER BY created_at DESC', [personName])
    : getAll('SELECT * FROM memories ORDER BY created_at DESC');
  return rows.map(m => ({ ...m, tags: JSON.parse(m.tags || '[]'), people: JSON.parse(m.people || '[]') }));
}

function searchMemories(query, personName) {
  const q = `%${query}%`;
  const rows = personName
    ? getAll(`SELECT * FROM memories WHERE person_name = ? AND (title LIKE ? OR content LIKE ? OR tags LIKE ?) ORDER BY created_at DESC`, [personName, q, q, q])
    : getAll(`SELECT * FROM memories WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY created_at DESC`, [q, q, q]);
  return rows.map(m => ({ ...m, tags: JSON.parse(m.tags || '[]'), people: JSON.parse(m.people || '[]') }));
}

function deleteMemory(id) {
  run('DELETE FROM memories WHERE id = ?', [id]);
}

function updateMemoryTTS(id, tts_url) {
  run('UPDATE memories SET tts_url = ? WHERE id = ?', [tts_url, id]);
}

// ── Person operations ──────────────────────────
function getAllPersons() {
  return getAll('SELECT * FROM persons ORDER BY created_at ASC');
}

function getPerson(name) {
  return getOne('SELECT * FROM persons WHERE name = ?', [name]);
}

function savePerson(data) {
  const id = uuidv4();
  run(
    `INSERT OR REPLACE INTO persons (id, name, relationship, voice_id, avatar_color)
     VALUES (?, ?, ?, ?, ?)`,
    [id, data.name, data.relationship || null, data.voice_id || null, data.avatar_color || '#F59E0B']
  );
  return getOne('SELECT * FROM persons WHERE name = ?', [data.name]);
}

function updatePersonAssistant(name, assistant_id) {
  run('UPDATE persons SET backboard_assistant_id = ? WHERE name = ?', [assistant_id, name]);
}

function updatePersonVoiceId(name, voice_id) {
  run('UPDATE persons SET voice_id = ? WHERE name = ?', [voice_id, name]);
}

module.exports = {
  initDB,
  saveMemory, getMemory, getAllMemories, searchMemories, updateMemoryTTS, deleteMemory,
  getAllPersons, getPerson, savePerson, updatePersonVoiceId, updatePersonAssistant
};
