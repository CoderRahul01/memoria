/**
 * Postgres (Neon) data layer. Every row belongs to a family — a private space
 * opened with a secret family key, so no two households ever see each other's memories.
 */
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5
});

const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
const one = (sql, params = []) => q(sql, params).then(r => r[0] || null);

const hashKey = key => crypto.createHash('sha256').update(String(key)).digest('hex');

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS families (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key_hash TEXT UNIQUE NOT NULL,
      owner_name TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      paid_at TIMESTAMPTZ,
      payment_id TEXT,
      payer_email TEXT,
      timezone TEXT,
      language TEXT,
      device TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS persons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      relationship TEXT,
      voice_id TEXT,
      backboard_assistant_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (family_id, name)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      person_name TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]',
      people JSONB NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'story',
      memory_date TEXT,
      source TEXT NOT NULL DEFAULT 'typed',
      tts_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memories_family_person ON memories (family_id, person_name, created_at DESC);
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      family_id UUID,
      name TEXT NOT NULL,
      props JSONB NOT NULL DEFAULT '{}',
      ms INTEGER,
      ok BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_created ON events (created_at DESC);
    CREATE INDEX IF NOT EXISTS events_name_created ON events (name, created_at DESC);
    CREATE TABLE IF NOT EXISTS presence (
      family_id UUID PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
      view TEXT NOT NULL,
      person TEXT,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ── Families ───────────────────────────────────
async function createFamily({ owner_name, timezone, language, device } = {}) {
  const key = crypto.randomBytes(18).toString('base64url');
  const family = await one(
    `INSERT INTO families (key_hash, owner_name, timezone, language, device) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [hashKey(key), owner_name || null, timezone || null, language || null, device || null]
  );
  return { key, family };
}

const familyByKey = key => key ? one('SELECT * FROM families WHERE key_hash = $1', [hashKey(key)]) : null;
const familyById = id => one('SELECT * FROM families WHERE id = $1', [id]);
const touchFamily = id => q('UPDATE families SET last_seen = now() WHERE id = $1', [id]);
const renameFamily = (id, owner_name) => one('UPDATE families SET owner_name = $2 WHERE id = $1 RETURNING *', [id, owner_name]);

async function markLifetime(id, { payment_id, email }) {
  return one(
    `UPDATE families SET plan = 'lifetime', paid_at = COALESCE(paid_at, now()), payment_id = $2, payer_email = $3
     WHERE id = $1 RETURNING *`, [id, payment_id || null, email || null]);
}

// ── Persons ────────────────────────────────────
async function getAllPersons(familyId) {
  return q(`SELECT p.*, (SELECT COUNT(*)::int FROM memories m WHERE m.family_id = p.family_id AND m.person_name = p.name) AS memory_count
            FROM persons p WHERE family_id = $1 ORDER BY created_at ASC`, [familyId]);
}
const getPerson = (familyId, name) => one('SELECT * FROM persons WHERE family_id = $1 AND name = $2', [familyId, name]);
const savePerson = (familyId, { name, relationship }) => one(
  `INSERT INTO persons (family_id, name, relationship) VALUES ($1,$2,$3)
   ON CONFLICT (family_id, name) DO UPDATE SET relationship = COALESCE(EXCLUDED.relationship, persons.relationship) RETURNING *`,
  [familyId, name, relationship || null]);
const updatePersonAssistant = (familyId, name, id) => q('UPDATE persons SET backboard_assistant_id = $3 WHERE family_id = $1 AND name = $2', [familyId, name, id]);
const updatePersonVoiceId = (familyId, name, id) => q('UPDATE persons SET voice_id = $3 WHERE family_id = $1 AND name = $2', [familyId, name, id]);

// ── Memories ───────────────────────────────────
const saveMemory = (familyId, d) => one(
  `INSERT INTO memories (family_id, person_name, title, content, tags, people, category, memory_date, source)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [familyId, d.person_name, d.title, d.content, JSON.stringify(d.tags || []), JSON.stringify(d.people || []),
   d.category || 'story', d.memory_date || null, d.source || 'typed']);

const getMemory = (familyId, id) => one('SELECT * FROM memories WHERE family_id = $1 AND id = $2', [familyId, id]).catch(() => null);
const getAllMemories = (familyId, personName) =>
  q('SELECT * FROM memories WHERE family_id = $1 AND person_name = $2 ORDER BY created_at DESC', [familyId, personName]);
const countMemories = familyId => one('SELECT COUNT(*)::int AS n FROM memories WHERE family_id = $1', [familyId]).then(r => r.n);

function searchMemories(familyId, query, personName) {
  const like = `%${query}%`;
  return q(`SELECT * FROM memories WHERE family_id = $1 AND person_name = $2
            AND (title ILIKE $3 OR content ILIKE $3 OR tags::text ILIKE $3) ORDER BY created_at DESC`, [familyId, personName, like]);
}
const deleteMemory = (familyId, id) => q('DELETE FROM memories WHERE family_id = $1 AND id = $2', [familyId, id]);
const updateMemoryTTS = (id, url) => q('UPDATE memories SET tts_url = $2 WHERE id = $1', [id, url]);

// ── Presence (who is using Memoria right now) ──
const heartbeat = (familyId, view, person) => q(
  `INSERT INTO presence (family_id, view, person, seen_at) VALUES ($1,$2,$3,now())
   ON CONFLICT (family_id) DO UPDATE SET view = EXCLUDED.view, person = EXCLUDED.person, seen_at = now()`,
  [familyId, view, person]).catch(e => console.warn('presence:', e.message));

// ── Events (analytics) ─────────────────────────
function logEvent(familyId, name, props = {}, ms = null, ok = true) {
  return q('INSERT INTO events (family_id, name, props, ms, ok) VALUES ($1,$2,$3,$4,$5)',
    [familyId || null, name, JSON.stringify(props), ms == null ? null : Math.round(ms), ok]).catch(e => console.warn('event:', e.message));
}

module.exports = {
  pool, q, one, initDB,
  createFamily, familyByKey, familyById, touchFamily, renameFamily, markLifetime,
  getAllPersons, getPerson, savePerson, updatePersonAssistant, updatePersonVoiceId,
  saveMemory, getMemory, getAllMemories, countMemories, searchMemories, deleteMemory, updateMemoryTTS,
  heartbeat, logEvent
};
