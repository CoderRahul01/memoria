/**
 * Real recordings. The family's audio is kept privately in Postgres, next to the words
 * Scribe heard and when each word was said. It is only ever served through a short-lived
 * signed link, so an <audio> tag can play it without exposing the family key.
 */
const crypto = require('crypto');
const db = require('./db');
const storage = require('./storage');

// Signing key: AUDIO_SIGNING_KEY if set, otherwise derived from the database secret (never sent to clients).
const SIGNING_KEY = crypto.createHash('sha256')
  .update('memoria-audio:' + (process.env.AUDIO_SIGNING_KEY || process.env.DATABASE_URL || 'dev')).digest();
const LINK_TTL_S = 6 * 3600;

function sign(memoryId, exp) {
  return crypto.createHmac('sha256', SIGNING_KEY).update(`${memoryId}.${exp}`).digest('base64url');
}

function signedUrl(memoryId) {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  return `/api/audio/${memoryId}?exp=${exp}&sig=${sign(memoryId, exp)}`;
}

function verify(memoryId, exp, sig) {
  if (!/^[0-9a-f-]{36}$/i.test(memoryId) || !/^\d+$/.test(String(exp)) || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(memoryId, exp));
  const given = Buffer.from(String(sig || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Listen links: one story, play-only, no expiry. Printed in the keepsake book as a QR code.
// They never carry the family key, and deleting the story kills the link.
const listenSig = memoryId => crypto.createHmac('sha256', SIGNING_KEY).update(`listen:${memoryId}`).digest('base64url').slice(0, 22);
const listenToken = memoryId => `${memoryId}.${listenSig(memoryId)}`;
function verifyListen(token) {
  const [id, sig] = String(token || '').split('.');
  if (!/^[0-9a-f-]{36}$/i.test(id || '') || !sig) return null;
  const a = Buffer.from(listenSig(id)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

/** Keeps the recording in object storage when configured, otherwise in Postgres. Never drops it. */
async function save(memoryId, familyId, { buffer, mime, duration, words, language }) {
  let key = null;
  if (storage.enabled()) {
    try {
      key = storage.keyFor(familyId, memoryId, mime);
      await storage.put(key, buffer, mime);
    } catch (e) {
      console.warn('Object storage failed, keeping the recording in Postgres:', e.message);
      key = null;
    }
  }
  return db.q(
    `INSERT INTO recordings (memory_id, family_id, mime, audio, size_bytes, duration_s, words, language, storage_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (memory_id) DO NOTHING`,
    [memoryId, familyId, mime, key ? null : buffer, buffer.length, duration || null, JSON.stringify(words || []), language || null, key]);
}

// Metadata only: the audio bytes are never loaded just to answer a request.
const getMeta = memoryId => db.one(
  'SELECT mime, size_bytes, storage_key, octet_length(audio) AS len FROM recordings WHERE memory_id = $1', [memoryId]);
// Postgres-stored audio is read slice by slice, so seeking doesn't pull the whole file into memory.
const getRange = (memoryId, start, length) => db.one(
  'SELECT substring(audio FROM $2 FOR $3) AS chunk FROM recordings WHERE memory_id = $1', [memoryId, start + 1, length]).then(r => r?.chunk);
const storageKeyOf = memoryId => db.one('SELECT storage_key FROM recordings WHERE memory_id = $1', [memoryId]).then(r => r?.storage_key || null);
const getWords = memoryIds => memoryIds.length
  ? db.q('SELECT memory_id, words, duration_s FROM recordings WHERE memory_id = ANY($1::uuid[])', [memoryIds])
  : Promise.resolve([]);

const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}']+/gu, '');

/**
 * Find where a quote was said: the window of recorded words that best matches the quote's words.
 * Works even if the family corrected a word or two in the text. Returns { start, end } in seconds, or null.
 */
function clipFor(words, quote) {
  const target = String(quote).replace(/…$/, '').split(/\s+/).map(norm).filter(Boolean);
  const spoken = (words || []).map(w => ({ ...w, n: norm(w.text) })).filter(w => w.n);
  if (!target.length || !spoken.length) return null;
  const want = new Set(target);
  const len = Math.min(target.length, spoken.length);
  let best = { score: 0, i: 0 };
  for (let i = 0; i + len <= spoken.length; i++) {
    let score = 0;
    for (let k = 0; k < len; k++) if (want.has(spoken[i + k].n)) score++;
    if (score > best.score) best = { score, i };
  }
  if (best.score < Math.max(2, Math.ceil(len * 0.5))) return null;
  // Trim unmatched words off both ends of the window.
  let a = best.i, b = best.i + len - 1;
  while (a < b && !want.has(spoken[a].n)) a++;
  while (b > a && !want.has(spoken[b].n)) b--;
  return { start: Math.max(0, spoken[a].start - 0.25), end: spoken[b].end + 0.4 };
}

module.exports = { signedUrl, verify, listenToken, verifyListen, save, getMeta, getRange, storageKeyOf, getWords, clipFor };
