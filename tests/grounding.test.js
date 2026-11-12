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

describe('interviewer follow-up and family-wide answers without a model', () => {
  it('asks no follow-up when there is no model or too little to go on', async () => {
    assert.equal(await gemma.followUp('हाँ', 'Q', 'Nani'), null);
    assert.equal(await gemma.followUp('My father worked in the railway and took us to the river every Sunday.', 'Q', 'Nani'), null);
  });
  it('family-wide Ask still only quotes recorded words', async () => {
    const memories = [
      { id: 'n', person_name: 'Nani', title: 'Kanpur', content: 'We lived in Kanpur in 1968, near the station.', category: 'place' },
      { id: 'm', person_name: 'Mama', title: 'Moving', content: 'We moved to Kanpur in 1970, I was six.', category: 'place' }
    ];
    const r = await gemma.answerQuestion('When did we live in Kanpur?', memories, 'The family', null, { everyone: true });
    assert.equal(r.grounded, true);
    for (const c of r.citations) assert.ok(memories.find(m => m.id === c.id).content.includes(c.quote.replace(/…$/, '').slice(0, 15)));
  });
});

describe('scale and cost guards', () => {
  const quota = require('../src/quota');
  const stt = require('../src/stt');
  it('keeps just the quoted words when the transcript is one long run-on sentence', () => {
    const runOn = 'मेरी माँ सुबह 4 बजे उठती थी दाल बनाते समय पहले जीरा डालो फिर हींग और प्याज़ को कभी जल्दी मत करो यह 1968 की है जब हम कानपुर में रहते थे';
    assert.equal(gemma.verifyQuote(runOn, 'फिर हींग और प्याज़ को कभी जल्दी मत करो'), 'फिर हींग और प्याज़ को कभी जल्दी मत करो');
  });
  it('estimates word timings across the recording, marked approximate', () => {
    const w = stt.approxWords('one two three four', 8);
    assert.equal(w.length, 4);
    assert.equal(w[0].start, 0);
    assert.ok(Math.abs(w[3].end - 8) < 0.02);
    assert.ok(w.every(x => x.approx));
  });
  it('caps a family at its daily Ask allowance', () => {
    const fam = { id: 'quota-test-' + Date.now(), plan: 'free' };
    for (let i = 0; i < 20; i++) assert.equal(quota.allowAsk(fam, 20), true);
    assert.equal(quota.allowAsk(fam, 20), false);
  });
  it('never caps Lifetime model access', () => {
    for (let i = 0; i < 5000; i++) quota.allowModel({ plan: 'free' });
    assert.equal(quota.allowModel({ plan: 'free' }), false, 'free families stop at the daily cap');
    assert.equal(quota.allowModel({ plan: 'lifetime' }), true);
  });
});

describe('hybrid transcription alignment', () => {
  const { alignWords } = require('../src/stt');
  it('keeps the accurate words and borrows exact timings where words match', () => {
    const timed = [['मेरी', 0, 0.3], ['मा', 0.3, 0.5], ['सुबह', 0.5, 0.9], ['डाल', 1.0, 1.4], ['बनाते', 1.4, 1.8]].map(([text, start, end]) => ({ text, start, end }));
    const w = alignWords('मेरी माँ सुबह दाल बनाते', timed, 2);
    assert.deepEqual(w.map(x => x.text), ['मेरी', 'माँ', 'सुबह', 'दाल', 'बनाते']);
    assert.deepEqual([w[0].start, w[2].start, w[4].start], [0, 0.5, 1.4]);
    assert.ok(w[1].approx && w[3].approx, 'unmatched words are marked approximate');
    assert.ok(w.every((x, i) => i === 0 || x.start >= w[i - 1].start), 'timings never go backwards');
  });
});
