/**
 * Moves recordings kept in Postgres into object storage (R2), in small batches, then frees the
 * database space. Safe to re-run: it only touches rows that are still in Postgres, and a row is
 * only cleared after its upload succeeded.
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=memoria-audio \
 *   node scripts/move-audio-to-storage.js [--dry-run]
 */
require('dotenv').config();
const db = require('../src/db');
const storage = require('../src/storage');

(async () => {
  if (!storage.enabled()) { console.error('Object storage is not configured (R2_* env vars).'); process.exit(1); }
  const dry = process.argv.includes('--dry-run');
  const todo = await db.q('SELECT memory_id, family_id, mime, size_bytes FROM recordings WHERE storage_key IS NULL AND audio IS NOT NULL ORDER BY created_at');
  console.log(`${todo.length} recordings in Postgres${dry ? ' (dry run)' : ''}`);
  let moved = 0, bytes = 0;
  for (const r of todo) {
    const key = storage.keyFor(r.family_id, r.memory_id, r.mime);
    if (dry) { console.log('would move', r.memory_id, '->', key); continue; }
    const row = await db.one('SELECT audio FROM recordings WHERE memory_id = $1', [r.memory_id]);
    await storage.put(key, row.audio, r.mime);
    const back = await storage.get(key);
    if (back.length !== row.audio.length) throw new Error(`size mismatch for ${r.memory_id}; left in Postgres`);
    await db.q('UPDATE recordings SET storage_key = $2, audio = NULL WHERE memory_id = $1 AND storage_key IS NULL', [r.memory_id, key]);
    moved++; bytes += r.size_bytes;
  }
  console.log(`moved ${moved} recordings, ${(bytes / 1048576).toFixed(1)} MB freed from Postgres`);
  await db.pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
