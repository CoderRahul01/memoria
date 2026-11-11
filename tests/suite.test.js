/**
 * Automated Test Suite — Memoria Core & AI Engine
 * Run with: npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const recordings = require('../src/recordings');
const gemma = require('../src/gemma');
const billing = require('../src/billing');
const env = require('../src/env');
const gemini = require('../src/gemini');

describe('Cryptographic Audio Signing & Verification (recordings.js)', () => {
  const sampleMemoryId = '123e4567-e89b-12d3-a456-426614174000';

  it('generates a signed URL with valid expiration and signature', () => {
    const url = recordings.signedUrl(sampleMemoryId);
    assert.match(url, new RegExp(`^/api/audio/${sampleMemoryId}\\?exp=\\d+&sig=[\\w-]+$`));
  });

  it('verifies a freshly generated signature successfully', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const url = recordings.signedUrl(sampleMemoryId);
    const parsedExp = url.match(/exp=(\d+)/)[1];
    const parsedSig = url.match(/sig=([\w-]+)/)[1];

    const valid = recordings.verify(sampleMemoryId, parsedExp, parsedSig);
    assert.strictEqual(valid, true, 'Valid signature must pass verification');
  });

  it('rejects an expired timestamp', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60; // 1 minute in the past
    const invalid = recordings.verify(sampleMemoryId, pastExp, 'fakesig');
    assert.strictEqual(invalid, false, 'Expired signatures must be rejected');
  });

  it('rejects a tampered memory ID or forged signature', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tamperedId = '00000000-0000-0000-0000-000000000000';
    const invalid = recordings.verify(tamperedId, exp, 'forged-signature');
    assert.strictEqual(invalid, false, 'Forged signature must fail verification');
  });
});

describe('Sliding-Window Word Alignment (recordings.clipFor)', () => {
  const mockWords = [
    { text: 'In', start: 1.0, end: 1.2 },
    { text: '1971', start: 1.3, end: 1.8 },
    { text: 'we', start: 1.9, end: 2.1 },
    { text: 'took', start: 2.2, end: 2.5 },
    { text: 'the', start: 2.6, end: 2.7 },
    { text: 'train', start: 2.8, end: 3.2 },
    { text: 'to', start: 3.3, end: 3.4 },
    { text: 'Shimla', start: 3.5, end: 4.1 },
    { text: 'for', start: 4.2, end: 4.4 },
    { text: 'our', start: 4.5, end: 4.7 },
    { text: 'wedding', start: 4.8, end: 5.3 }
  ];

  it('extracts exact start and end timestamps for a spoken quote', () => {
    const quote = 'train to Shimla';
    const clip = recordings.clipFor(mockWords, quote);
    assert.ok(clip, 'Clip must be found');
    assert.ok(clip.start <= 2.8, 'Clip start should be at or just before the first word');
    assert.ok(clip.end >= 4.1, 'Clip end should cover through the last word');
  });

  it('returns null if words do not match the quote', () => {
    const quote = 'completely unrelated cooking recipe with turmeric';
    const clip = recordings.clipFor(mockWords, quote);
    assert.strictEqual(clip, null, 'Unrelated quotes should return null');
  });
});

describe('Zero-Hallucination Date Extraction (gemma.settleDate)', () => {
  it('preserves exact year when explicitly spoken', () => {
    const date = gemma.settleDate('We arrived in Bombay in 1968 after the floods.', '1968');
    assert.strictEqual(date, '1968');
  });

  it('rejects hallucinated years not spoken in the transcript', () => {
    const date = gemma.settleDate('My grandmother made the best mango pickle.', '1955');
    assert.strictEqual(date, null, 'Years invented by an LLM must be rejected');
  });

  it('preserves human uncertainty when speaker is unsure', () => {
    const date = gemma.settleDate('I think it happened in 1978, or maybe 1979.', '1978');
    assert.strictEqual(date, '1978 or 1979', 'Hedge ranges must be captured');
  });

  it('correctly formats decades', () => {
    const date = gemma.settleDate('Music was so much better in the 1980s.', null);
    assert.strictEqual(date, 'the 1980s');
  });
});

describe('Memory Ranking & Excerpt Selection', () => {
  const sampleMemories = [
    { id: '1', title: 'Grandma’s Garam Masala', content: 'Always roast the whole coriander seeds before grinding.', tags: ['spice', 'recipe'] },
    { id: '2', title: 'Leaving the Village', content: 'In 1962 my father packed three trunks and we took the morning bus.', tags: ['travel', 'migration'] },
    { id: '3', title: 'First Salary', content: 'I earned forty rupees and bought sweets for everyone.', tags: ['career', 'money'] }
  ];

  it('ranks memories accurately by keyword overlap', () => {
    const ranked = gemma.rankMemories('What was in the garam masala recipe?', sampleMemories, 1);
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].id, '1', 'Spice recipe must be top-ranked for garam masala query');
  });

  it('extracts the most relevant sentence as quote excerpt', () => {
    const memory = {
      content: 'The weather in Delhi was sweltering. We walked along the river for two hours. Later in the evening we met Uncle Sharma at the cafe.'
    };
    const excerpt = gemma.excerpt(memory, 'Where did you walk?');
    assert.match(excerpt, /river for two hours/);
  });
});

describe('Environment & Billing Guards', () => {
  it('filters placeholder API keys safely', () => {
    process.env.TEST_PLACEHOLDER_KEY = 'your_api_key_here';
    const val = env.configured('TEST_PLACEHOLDER_KEY');
    assert.strictEqual(val, null, 'Placeholder string must resolve to null');
    delete process.env.TEST_PLACEHOLDER_KEY;
  });

  it('defines valid free plan limits', () => {
    assert.strictEqual(billing.FREE_LIMITS.persons, 1, 'Free tier is limited to 1 loved one');
    assert.strictEqual(billing.FREE_LIMITS.memories, 15, 'Free tier is limited to 15 memories');
  });
});

describe('Gemini Model Engine (gemini.js)', () => {
  it('exposes enabled, generate, and modelLabel functions', () => {
    assert.strictEqual(typeof gemini.enabled, 'function');
    assert.strictEqual(typeof gemini.generate, 'function');
    assert.strictEqual(typeof gemini.modelLabel, 'function');
    assert.strictEqual(gemini.modelLabel(), 'gemini-2.5-flash');
  });
});
