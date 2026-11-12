/**
 * Grounding, next questions and listen links.
 * The promise under test: an answer is only ever backed by words the person actually said.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GEMINI_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.TINKER_API_KEY;
const gemma = require('../src/gemma');
const recordings = require('../src/recordings');

const hindi = 'मेरी माँ सुबह चार बजे उठती थीं। पहले जीरा डालो, फिर हींग, और प्याज़ को कभी जल्दी मत करो। यही असली राज़ है।';

describe('verifyQuote: quotes must exist in the real transcript', () => {
  it('accepts an exact quote and returns the full original sentence', () => {
    assert.equal(gemma.verifyQuote(hindi, 'फिर हींग, और प्याज़ को कभी जल्दी मत करो'), 'पहले जीरा डालो, फिर हींग, और प्याज़ को कभी जल्दी मत करो।');
  });
  it('tolerates punctuation and case differences', () => {
    assert.equal(gemma.verifyQuote('I built a canoe in 1968. It was pine.', 'i built a canoe in 1968'), 'I built a canoe in 1968.');
  });
  it('accepts a near-verbatim quote only when it clearly matches one sentence', () => {
    assert.equal(gemma.verifyQuote('Never sign anything the same day someone gives it to you. Sleep on it.',
      'Never sign anything the same day someone gives it to you'), 'Never sign anything the same day someone gives it to you.');
  });
  it('rejects words the person never said', () => {
    assert.equal(gemma.verifyQuote(hindi, 'she moved to Paris in 1990 and opened a bakery'), null);
    assert.equal(gemma.verifyQuote('I built a canoe.', 'I built a house in Delhi'), null);
  });
  it('rejects empty or one-word quotes', () => {
    assert.equal(gemma.verifyQuote(hindi, ''), null);
    assert.equal(gemma.verifyQuote(hindi, 'जीरा'), null);
  });
});

describe('answerQuestion without a model', () => {
  const memories = [
    { id: 'a', title: 'The biryani secret', content: 'Fry the onions slowly until dark brown. Soak the rice exactly forty minutes.', category: 'recipe' },
    { id: 'b', title: 'Night train', content: 'I took the night train to Bombay with forty rupees.', category: 'story' }
  ];
  it('says "not yet" honestly when nothing matches', async () => {
    const r = await gemma.answerQuestion('What was her wedding like?', memories, 'Nani');
    assert.equal(r.grounded, false);
    assert.deepEqual(r.citations, []);
    assert.match(r.answer, /hasn't talked about that yet/);
  });
  it('quotes their real words when something matches, never in their voice', async () => {
    const r = await gemma.answerQuestion('How long to soak the rice?', memories, 'Nani');
    assert.equal(r.grounded, true);
    assert.equal(r.citations[0].id, 'a');
    assert.ok(memories[0].content.includes(r.citations[0].quote.replace(/…$/, '').slice(0, 20)));
    assert.doesNotMatch(r.answer, /^I /);
  });
  it('handles an empty album', async () => {
    const r = await gemma.answerQuestion('anything', [], 'Nani');
    assert.equal(r.grounded, false);
  });
});

describe('nextQuestions without a model', () => {
  it('suggests starter topics for an empty album', async () => {
    const r = await gemma.nextQuestions([], 'Nani');
    assert.equal(r.questions.length, 3);
    assert.ok(r.questions.every(q => q.q && q.why === 'gap'));
  });
  it('follows up on people they mentioned and skips covered topics', async () => {
    const r = await gemma.nextQuestions([{ title: 'x', content: 'y', category: 'recipe', people: ['Suresh'] }], 'Nani');
    assert.match(r.questions[0].q, /Suresh/);
    assert.equal(r.questions[0].why, 'follow-up');
    assert.ok(!r.questions.some(q => /dish only you know/.test(q.q)), 'recipe is already covered');
  });
  it('never repeats a question that was already asked', async () => {
    const asked = 'Tell me about your parents. What were they like?';
    const r = await gemma.nextQuestions([{ title: 'x', content: 'y', category: 'recipe', asked }], 'Nani', null, 8);
    assert.ok(!r.questions.some(q => q.q === asked));
  });
});

describe('listen links (printed in the keepsake book)', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  it('round-trips a valid token to its story id', () => {
    assert.equal(recordings.verifyListen(recordings.listenToken(id)), id);
  });
  it('rejects tampered or foreign tokens', () => {
    const t = recordings.listenToken(id);
    assert.equal(recordings.verifyListen(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), null);
    assert.equal(recordings.verifyListen('123e4567-e89b-12d3-a456-426614174001.' + t.split('.')[1]), null);
    assert.equal(recordings.verifyListen('nonsense'), null);
  });
  it('is a different secret from the short-lived audio links', () => {
    assert.ok(!recordings.signedUrl(id).includes(recordings.listenToken(id).split('.')[1]));
  });
});
