#!/usr/bin/env node
/**
 * Provenance fixtures: does every AI path keep the speaker's uncertainty and corrections,
 * and do quotes + the "hasn't talked about this" boundary stay the same whichever model runs?
 *
 *   node scripts/provenance-check.js            # runs every engine as a separate process
 *   ENGINE=gemma-31b node scripts/provenance-check.js --one
 */
require('dotenv').config();
const { spawnSync } = require('child_process');

const ENGINES = {
  'gemma-31b': { BACKBOARD_MODEL: 'google/gemma-4-31b-it', BACKBOARD_FAST_MODEL: 'google/gemma-4-31b-it' },
  'gemma-26b': { BACKBOARD_MODEL: 'google/gemma-4-26b-a4b-it', BACKBOARD_FAST_MODEL: 'google/gemma-4-26b-a4b-it' },
  tinker: { BACKBOARD_API_KEY: '' },
  rules: { BACKBOARD_API_KEY: '', TINKER_API_KEY: '' }
};

const STORIES = [
  { id: 'a', content: 'I think it was 1978, or maybe 1979, when we moved to Pune. Your grandfather found a small flat near the station.',
    expectDate: d => d === '1978 or 1979', label: 'unsure year stays "1978 or 1979"' },
  { id: 'b', content: 'My best friend Ramesh, no sorry, Suresh, taught me to ride a cycle. We practised every evening behind the temple.',
    expectPeople: p => p.includes('Suresh') && !p.includes('Ramesh'), label: 'corrected name: Suresh, not Ramesh' },
  { id: 'c', content: 'Never sign anything the same day someone gives it to you. Sleep on it. That rule saved our shop twice.',
    expectDate: d => d == null, label: 'no year said, so no year invented' }
];
const QUESTIONS = [
  { q: 'Who taught her to ride a cycle?', grounded: true, from: 'b' },
  { q: 'Should I sign the contract today?', grounded: true, from: 'c' },
  { q: 'What was her favourite film?', grounded: false }
];

async function runOne() {
  const gemma = require('../src/gemma');
  const results = [];
  const memories = [];
  for (const s of STORIES) {
    const x = await gemma.extractMemory(s.content);
    memories.push({ id: s.id, title: x.title, content: s.content, memory_date: x.memory_date, tags: x.tags });
    if (s.expectDate) results.push([s.label, s.expectDate(x.memory_date), `got ${JSON.stringify(x.memory_date)} via ${x.engine}`]);
    if (s.expectPeople) results.push([s.label, s.expectPeople(x.people_mentioned || []), `got ${JSON.stringify(x.people_mentioned)} via ${x.engine}`]);
  }
  for (const t of QUESTIONS) {
    // Same code path the server uses: grounding and quotes come from the recorded text, not the model.
    const top = gemma.rankMemories(t.q, memories, 1)[0];
    const grounded = !!top;
    results.push([`"${t.q}" ${t.grounded ? 'is answered' : 'hits the "hasn\'t talked about this" boundary'}`, grounded === t.grounded && (!t.grounded || top.id === t.from), grounded ? `from story ${top.id}` : 'no story matched']);
    if (grounded) {
      const quote = gemma.excerpt(top, t.q);
      results.push([`  quote is their exact words`, top.content.includes(quote.replace(/…$/, '')), `"${quote}"`]);
    }
  }
  console.log(JSON.stringify(results));
}

if (process.argv.includes('--one')) {
  runOne().then(() => process.exit(0));
} else {
  let failed = 0;
  for (const [name, env] of Object.entries(ENGINES)) {
    const r = spawnSync(process.execPath, [__filename, '--one'], { env: { ...process.env, ...env, ENGINE: name }, encoding: 'utf8', timeout: 300_000 });
    const line = (r.stdout || '').trim().split('\n').pop();
    console.log(`\n── ${name}`);
    try {
      for (const [label, ok, detail] of JSON.parse(line)) {
        if (!ok) failed++;
        console.log(`${ok ? '✓' : '✗'} ${label}  (${detail})`);
      }
    } catch { failed++; console.log('✗ engine did not run:', (r.stderr || '').slice(-300)); }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll provenance checks passed on every engine.');
  process.exit(failed ? 1 : 0);
}
