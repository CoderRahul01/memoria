/**
 * Object storage for recordings (Cloudflare R2, or any S3-compatible store).
 *
 * Why: Postgres on a free plan holds ~0.5 GB, which is a couple of thousand minutes of audio.
 * R2's free tier holds 10 GB (~40,000 minutes at 32 kbps) with no charge for playback traffic.
 * When R2 isn't configured, recordings stay in Postgres exactly as before.
 *
 * Audio is private: the bucket is never public. Playback goes through our signed /api/audio link,
 * which redirects to a presigned URL that expires in minutes.
 */
const { AwsClient } = require('aws4fetch');
const { configured } = require('./env');

const ACCOUNT = configured('R2_ACCOUNT_ID');
const ACCESS = configured('R2_ACCESS_KEY_ID');
const SECRET = configured('R2_SECRET_ACCESS_KEY');
const BUCKET = process.env.R2_BUCKET || 'memoria-audio';
const ENDPOINT = (process.env.R2_ENDPOINT || (ACCOUNT ? `https://${ACCOUNT}.r2.cloudflarestorage.com` : '')).replace(/\/$/, '');

const on = !!(ENDPOINT && ACCESS && SECRET);
const client = on ? new AwsClient({ accessKeyId: ACCESS, secretAccessKey: SECRET, service: 's3', region: process.env.R2_REGION || 'auto' }) : null;

const enabled = () => on;
const objectUrl = key => `${ENDPOINT}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
const keyFor = (familyId, memoryId, mime = '') =>
  `families/${familyId}/${memoryId}.${/mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm'}`;

async function put(key, buffer, mime) {
  const res = await client.fetch(objectUrl(key), {
    method: 'PUT', body: buffer, headers: { 'Content-Type': mime || 'application/octet-stream' }
  });
  if (!res.ok) throw new Error(`storage put ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

/** A short-lived URL the browser can stream directly (supports Range for seeking). */
async function signedGet(key, ttlSeconds = 600) {
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
  const signed = await client.sign(url.toString(), { method: 'GET', aws: { signQuery: true } });
  return signed.url;
}

async function remove(key) {
  const res = await client.fetch(objectUrl(key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`storage delete ${res.status}`);
}

async function get(key) {
  const res = await client.fetch(objectUrl(key));
  if (!res.ok) throw new Error(`storage get ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { enabled, keyFor, put, signedGet, remove, get, host: () => (on ? new URL(ENDPOINT).host : null) };
