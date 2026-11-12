/** Hugging Face overflow: real token usage is priced, thinking is stripped, rate limits back off. No network. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.HF_TOKEN = 'hf_test_token_value_123';
const hf = require('../src/hf');

describe('Hugging Face Gemma overflow (hf.js)', () => {
  it('prices a call from the provider-reported token usage', async () => {
    let sent;
    global.fetch = async (url, opts) => {
      sent = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '<think>hmm</think>{"found": true}' } }], usage: { prompt_tokens: 4000, completion_tokens: 250 } }) };
    };
    const r = await hf.complete('Question: x', 'system');
    assert.equal(sent.url, 'https://router.huggingface.co/v1/chat/completions');
    assert.match(sent.body.model, /gemma-4/i);
    assert.equal(sent.auth, 'Bearer hf_test_token_value_123');
    assert.equal(r.text, '{"found": true}', 'thinking is stripped');
    assert.ok(Math.abs(r.usd - (4000 * 0.07 + 250 * 0.34) / 1e6) < 1e-12);
    assert.match(r.engine, /^hf:google\/gemma-4/);
  });
  it('estimates a conservative upper bound before calling', () => {
    assert.ok(hf.estimateUsd('x'.repeat(16000), '', 600) > (4000 * 0.07) / 1e6);
  });
  it('backs off after a rate limit instead of hammering the provider', async () => {
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
    assert.equal(await hf.complete('q', null), null);
    assert.equal(hf.enabled(), false);
  });
});
