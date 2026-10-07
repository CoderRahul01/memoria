/* Memoria — frontend */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  key: null,
  family: null,
  person: null,
  persons: [],
  memories: [],
  filter: 'all',
  health: null,
  current: null,
  freshId: null,
  view: 'home'
};

const FILTER_LABELS = { all: 'All', recipe: 'Recipes', story: 'Stories', advice: 'Advice', family: 'Family', event: 'Events', place: 'Places', other: 'Other' };

const PROMPTS = [
  'What’s a recipe only you know how to make?',
  'Tell me about the day you got married.',
  'What was the house you grew up in like?',
  'What advice would you give your grandchildren?',
  'Who was your best friend growing up?',
  'What was your first job, and what did it pay?',
  'What’s the hardest thing you ever went through?',
  'Which festival do you remember most, and why?'
];
const OWN_PROMPTS = [
  'What do you want your kids to know about you?',
  'What’s a recipe you never want lost?',
  'What was the best day of your life?',
  'What’s a mistake that taught you something?',
  'Where did you grow up, and what was it like?'
];

// ── Storage (may be unavailable in private mode) ───────────────
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

// ── API ────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const headers = { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(state.key ? { 'X-Family-Key': state.key } : {}) };
  const res = await fetch(path, { ...opts, headers, body: isForm ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'no_family') { forgetFamily(); throw new Error(data.error); }
  if (res.status === 402) { openUpgrade(data.error); throw Object.assign(new Error(data.error), { quiet: true }); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
const track = (name, props = {}) => state.key && api('/api/track', { method: 'POST', body: { name, props } }).catch(() => {});

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3800);
}
const fail = err => err?.quiet || toast(err.message, 'error');

function busy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = name => (name || '?').trim()[0]?.toUpperCase() || '?';
const isSelf = () => state.person?.relationship === 'myself';
const yearOf = s => +(String(s || '').match(/\b(1[89]\d\d|20\d\d)\b/)?.[1] || 0);

// ── Routing ────────────────────────────────────────────────────
const APP_VIEWS = ['home', 'record', 'ask', 'story'];
function show(view) {
  const all = ['landing', 'welcome', ...APP_VIEWS];
  const swap = () => all.forEach(v => ($(`#view-${v}`).hidden = v !== view));
  if (document.startViewTransition && route.booted && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const vt = document.startViewTransition(swap);
    vt.ready.catch(() => {}); vt.finished.catch(() => {});
  } else swap();
  document.body.className = view === 'landing' ? 'mode-landing' : view === 'welcome' ? 'mode-welcome' : 'mode-app';
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === view));
  window.scrollTo({ top: 0 });
  observeReveals();
}

// The homepage is always the front door: the bare address (and its #demo / #how / #pricing
// sections) shows it to everyone. The app lives at #home, #record, #ask and #story.
const LANDING_ANCHORS = ['demo', 'how', 'pricing'];
function route() {
  const hash = location.hash.slice(1);
  $$('.landing-only[data-start]').forEach(b => (b.textContent = state.key ? 'Open my album' : 'Start free'));
  if (!hash || LANDING_ANCHORS.includes(hash) || (!state.key && hash !== 'start')) {
    show('landing');
    route.booted = true;
    if (LANDING_ANCHORS.includes(hash)) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }));
    return;
  }
  if (hash === 'start') {
    if (state.key && state.persons.length) { location.replace('#record'); return; }
    show('welcome');
    route.booted = true;
    return;
  }
  const view = APP_VIEWS.includes(hash) ? hash : 'home';
  state.view = view;
  show(view);
  route.booted = true;
  if (view === 'story') loadStory();
  if (view === 'ask') renderSuggestions();
  if (view === 'home') renderMemories();
  heartbeat();
  track('view', { view });
}
window.addEventListener('hashchange', route);

// ── Family space ───────────────────────────────────────────────
function takeKeyFromUrl() {
  const m = location.hash.match(/^#k=([\w-]{16,64})/);
  if (!m) return;
  lsSet('memoria.key', m[1]);
  history.replaceState(null, '', location.pathname + '#home');
  toast('Welcome to the family album');
}

function forgetFamily() {
  state.key = null; state.family = null;
  lsSet('memoria.key', null);
  location.hash = '';
  route();
}

const privateLink = () => `${location.origin}/#k=${state.key}`;

$$('[data-start]').forEach(b => b.addEventListener('click', () => {
  location.hash = !state.key ? 'start' : b.classList.contains('landing-only') ? 'home' : 'record';
}));

$('#relChips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#relChips button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  const name = $('#wName');
  if (b.dataset.rel === 'myself') { name.value = $('#wOwner').value || ''; name.placeholder = 'Your name'; }
  else if (b.dataset.name) name.value = b.dataset.name;
  else { name.value = ''; name.placeholder = 'Nani, Uncle Joe, Aunt Rosa…'; }
  name.focus();
});
$$('#relChips button').forEach(b => b.setAttribute('role', 'radio'));

$('#welcomeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.submitter || $('#welcomeForm button');
  const rel = $('#relChips [aria-checked="true"]')?.dataset.rel || null;
  const name = $('#wName').value.trim();
  if (!name) return;
  busy(btn, true);
  try {
    const r = await api('/api/family', {
      method: 'POST',
      body: { owner_name: $('#wOwner').value.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language }
    });
    state.key = r.key;
    state.family = r.family;
    lsSet('memoria.key', r.key);
    const p = await api('/api/persons', { method: 'POST', body: { name, relationship: rel } });
    lsSet('memoria.person', p.name);
    track('onboarded', { relationship: rel || 'other' });
    await loadPersons();
    location.hash = 'record';
    toast(`${p.name}’s album is ready. Press the tape to begin.`);
  } catch (err) { fail(err); }
  finally { busy(btn, false); }
});

async function loadFamily() {
  state.family = await api('/api/family');
  renderPlan();
}

function renderPlan() {
  const f = state.family;
  if (!f) return;
  const life = f.plan === 'lifetime';
  $('#sOwner').textContent = f.owner_name || 'you';
  $('#ownerInput').value = f.owner_name || '';
  $('#planRow').innerHTML = life
    ? `<span><span class="plan-badge life">Lifetime</span></span><span>Everything unlocked. Thank you.</span>`
    : `<span><span class="plan-badge">Free</span> ${f.memory_count} of ${f.limits.memories} stories</span>
       <button class="pill pill-accent" data-upgrade>Lifetime · ${esc(f.price)}</button>`;
  renderVoiceStatus();
}

// ── Presence (powers the live view in the founder dashboard) ───
function heartbeat() {
  if (!state.key || document.hidden) return;
  api('/api/presence', { method: 'POST', body: { view: state.view, person: state.person?.name } }).catch(() => {});
}
setInterval(heartbeat, 30_000);
document.addEventListener('visibilitychange', heartbeat);

// ── Persons ────────────────────────────────────────────────────
async function loadPersons() {
  state.persons = await api('/api/persons').catch(() => []);
  const saved = lsGet('memoria.person');
  const found = state.persons.find(p => p.name === saved) || state.persons[0];
  if (found) await setPerson(found, true);
  else if (APP_VIEWS.includes(location.hash.slice(1))) location.hash = 'start';
}

async function setPerson(p, reload = true) {
  state.person = p;
  lsSet('memoria.person', p.name);
  const self = isSelf();
  $('#chipName').textContent = p.name;
  $('#chipAvatar').textContent = initial(p.name);
  $('#heroName').textContent = self ? 'Your' : p.name;
  $('#heroName').parentElement.innerHTML = self ? `<span id="heroName">Your</span> stories` : `<span id="heroName">${esc(p.name)}</span>’s stories`;
  $('#homeLede').textContent = self ? 'The stories you want the people you love to keep.' : `Every story ${p.name} has told, kept in their own words.`;
  $$('.pname').forEach(el => (el.textContent = self ? 'you' : p.name));
  $('#cName').textContent = p.name;
  $('#chat').innerHTML = '';
  renderPrompts();
  renderVoiceStatus();
  if (reload) await loadMemories();
  if (!$('#view-story').hidden) loadStory();
  heartbeat();
}

function openPersonSheet() {
  $('#personList').innerHTML = state.persons.map((p, i) => `
    <li><button data-i="${i}" class="${p.name === state.person?.name ? 'current' : ''}">
      <span class="avatar">${esc(initial(p.name))}</span>
      <span><b>${esc(p.name)}</b><small>${esc(p.relationship === 'myself' ? 'your own stories' : p.relationship || '')}${p.relationship ? ' · ' : ''}${p.memory_count || 0} stories</small></span>
    </button></li>`).join('');
  $('#personSheet').hidden = false;
}

$('#personList').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  setPerson(state.persons[b.dataset.i]);
  closeSheets();
});

$('#addPersonForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const p = await api('/api/persons', { method: 'POST', body: { name: $('#newName').value, relationship: $('#newRel').value } });
    e.target.reset();
    state.persons = await api('/api/persons');
    await setPerson(state.persons.find(x => x.name === p.name) || p);
    closeSheets();
    toast(`Now keeping ${p.name}’s stories`);
  } catch (err) { fail(err); }
});

// ── Memories ───────────────────────────────────────────────────
async function loadMemories() {
  if (!state.person) return;
  const q = $('#searchInput').value.trim();
  const params = new URLSearchParams({ person: state.person.name });
  if (q) params.set('q', q);
  try {
    const list = await api(`/api/memories?${params}`);
    if (q) state.results = list; else { state.memories = list; state.results = null; }
  } catch (err) {
    fail(err);
  }
  renderFilters();
  renderMemories();
  renderThread();
}

function renderFilters() {
  const cats = ['all', ...new Set(state.memories.map(m => m.category))];
  if (!cats.includes(state.filter)) state.filter = 'all';
  $('#filters').innerHTML = cats.length > 2 ? cats.map(c =>
    `<button role="tab" aria-selected="${c === state.filter}" data-cat="${c}">${FILTER_LABELS[c] || c}</button>`).join('') : '';
}

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  state.filter = b.dataset.cat;
  renderFilters();
  renderMemories();
});

function cardHTML(m, i, example = false) {
  const when = m.memory_date || formatDate(m.created_at);
  return `<button class="mcard ${m.id === state.freshId ? 'fresh' : ''}" data-id="${m.id || ''}" style="--i:${i}" ${example ? 'tabindex="-1"' : ''}>
      <span class="meta"><span class="cat">${esc(example ? 'example' : m.category)}</span><span>${esc(when)}</span></span>
      <h3>${esc(m.title)}</h3>
      <p>${esc(m.content)}</p>
      <span class="from">— ${esc(example ? m.who : state.person?.name)}</span>
    </button>`;
}

const EXAMPLES = [
  { title: 'The biryani secret', who: 'Nani', memory_date: '1968', content: 'Fry the onions slowly until they are dark brown, almost burnt, and save that oil. One teaspoon of shahi jeera, two black cardamoms, never green. Soak the rice exactly forty minutes.' },
  { title: 'Forty rupees and a night train', who: 'Grandpa', memory_date: '1971', content: 'I took the night train to Bombay with forty rupees in my pocket. I slept at the station for three nights before Mr. Desai gave me a job sweeping the floor of his printing press.' },
  { title: 'Sleep on it', who: 'Dad', memory_date: '1991', content: 'Never sign anything the same day someone gives it to you. Sleep on it. That one rule saved our shop twice.' }
];

function renderMemories() {
  const base = state.results || state.memories;
  const list = state.filter === 'all' ? base : base.filter(m => m.category === state.filter);
  const searching = !!$('#searchInput').value.trim();
  const showingExamples = $('#memoryGrid').dataset.examples === '1' && !state.memories.length;
  $('#emptyState').hidden = state.memories.length > 0 || searching || showingExamples;
  if (showingExamples) {
    $('#memoryGrid').innerHTML = EXAMPLES.map((m, i) => cardHTML(m, i, true)).join('');
    return;
  }
  $('#memoryGrid').innerHTML = list.length ? list.map((m, i) => cardHTML(m, i)).join('')
    : searching ? `<p class="muted">No story mentions “${esc($('#searchInput').value)}” yet. Try asking about it instead.</p>` : '';
  state.freshId = null;
}

// The life thread: dated memories placed along a line by year.
function renderThread() {
  const dated = state.memories.map(m => ({ m, y: yearOf(m.memory_date) })).filter(x => x.y);
  const fig = $('#thread');
  if (dated.length < 2) { fig.hidden = true; return; }
  const ys = dated.map(d => d.y), min = Math.min(...ys), max = Math.max(...ys);
  const span = Math.max(1, max - min);
  dated.sort((a, b) => a.y - b.y);
  fig.hidden = false;
  $('#threadTrack').classList.toggle('labeled', dated.length <= 5);
  $('#threadTrack').innerHTML = dated.map((d, i) => {
    const left = 4 + ((d.y - min) / span) * 92;
    return `<button class="t-dot ${i % 2 ? 'up' : ''}" style="left:${left}%;--i:${i}" data-id="${d.m.id}" aria-label="${esc(d.m.title)}, ${d.y}">
      <span class="yr">${d.y}</span><span class="tt">${esc(d.m.title)}</span></button>`;
  }).join('');
}
$('#threadTrack').addEventListener('click', e => {
  const b = e.target.closest('.t-dot');
  if (b) openMemory(state.memories.find(m => m.id === b.dataset.id));
});

$('#memoryGrid').addEventListener('click', e => {
  const card = e.target.closest('.mcard');
  if (card?.dataset.id) openMemory((state.results || state.memories).find(m => m.id === card.dataset.id));
});

let searchTimer;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMemories, 250);
});

$('#seedBtn').addEventListener('click', () => {
  $('#memoryGrid').dataset.examples = '1';
  renderMemories();
  toast('These are examples. Your own stories will replace them.');
});

function formatDate(s) {
  const d = new Date(s);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Their real voice ───────────────────────────────────────────
const player = { audio: new Audio(), stopAt: null, btn: null };
player.audio.preload = 'auto';
player.audio.addEventListener('timeupdate', () => {
  if (player.stopAt != null && !player.audio.seeking && player.audio.currentTime >= player.stopAt) stopVoice();
});
player.audio.addEventListener('ended', stopVoice);
function stopVoice() {
  player.audio.pause();
  player.stopAt = null;
  if (player.btn) { player.btn.classList.remove('playing'); player.btn.textContent = player.btn.dataset.label; player.btn = null; }
}
async function playVoice(url, start = 0, end = null, btn = null) {
  if (player.btn === btn && btn && !player.audio.paused) return stopVoice();
  stopVoice();
  if (!player.audio.src.endsWith(url)) player.audio.src = url;
  await new Promise(r => player.audio.readyState >= 1 ? r() : player.audio.addEventListener('loadedmetadata', r, { once: true }));
  if (Math.abs(player.audio.currentTime - start) > 0.05) {
    const seeked = new Promise(r => player.audio.addEventListener('seeked', r, { once: true }));
    player.audio.currentTime = start;
    await seeked; // don't let a stale position end the clip before it starts
  }
  player.stopAt = end;
  if (btn) { btn.dataset.label ||= btn.textContent; btn.textContent = 'Stop'; btn.classList.add('playing'); player.btn = btn; }
  await player.audio.play().catch(() => { stopVoice(); toast('Tap again to play.'); });
}
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ── Memory sheet ───────────────────────────────────────────────
function openMemory(m) {
  if (!m) return;
  state.current = m;
  $('#mMeta').textContent = [m.category, m.memory_date, `kept ${formatDate(m.created_at)}`].filter(Boolean).join(' · ');
  $('#mTitle').textContent = m.title;
  $('#mTags').innerHTML = (m.tags || []).map(t => `<span>${esc(t)}</span>`).join('');
  $('#mContent').textContent = m.content;
  stopVoice();
  const btn = $('#mPlay');
  btn.hidden = !m.has_voice;
  btn.dataset.label = m.voice_seconds ? `Listen to ${isSelf() ? 'yourself' : m.person_name || 'them'} · ${mmss(m.voice_seconds)}` : 'Listen';
  btn.textContent = btn.dataset.label;
  $('#mTyped').hidden = !!m.has_voice;
  $('#mDelete').textContent = 'Delete';
  $('#memorySheet').hidden = false;
}

$('#mPlay').addEventListener('click', async () => {
  const m = state.current, btn = $('#mPlay');
  if (player.btn === btn) return stopVoice();
  try {
    const { url } = await api(`/api/memories/${m.id}/voice`);
    await playVoice(url, 0, null, btn);
  } catch (err) { fail(err); }
});

function browserSpeak(text, btn) {
  if (!('speechSynthesis' in window)) return toast('This browser can’t read out loud.', 'error');
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  if (btn) { btn.textContent = 'Stop'; u.onend = u.onerror = () => (btn.textContent = 'Listen'); }
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

$('#mDelete').addEventListener('click', async () => {
  const m = state.current, btn = $('#mDelete');
  if (btn.dataset.confirm !== m.id) {
    btn.dataset.confirm = m.id;
    btn.textContent = 'Tap again to delete';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete'; }, 3000);
    return;
  }
  try {
    await api(`/api/memories/${m.id}`, { method: 'DELETE' });
    btn.dataset.confirm = '';
    closeSheets();
    toast('Story deleted');
    loadMemories(); loadFamily();
  } catch (err) { fail(err); }
});

function closeSheets() {
  $$('.sheet-backdrop:not([hidden])').forEach(s => {
    s.classList.add('closing');
    setTimeout(() => { s.hidden = true; s.classList.remove('closing'); }, 220);
  });
  stopVoice();
  speechSynthesis.cancel?.();
}
$$('.sheet-backdrop').forEach(bd => bd.addEventListener('click', e => {
  if (e.target === bd || e.target.closest('[data-close]')) closeSheets();
}));
document.addEventListener('keydown', e => e.key === 'Escape' && closeSheets());
$('#personChip').addEventListener('click', openPersonSheet);
$('#settingsBtn').addEventListener('click', () => { renderPlan(); $('#settingsSheet').hidden = false; });

// ── Recording: the cassette ────────────────────────────────────
const DEFAULT_PLACEHOLDER = $('#transcript').placeholder;
const rec = { media: null, chunks: [], blob: null, stream: null, sr: null, timer: null, start: 0, edited: false, finalText: '', ctx: null };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TAPE_SECONDS = 600; // a full side: the left reel empties into the right over ten minutes

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

let promptStart = 0;
function renderPrompts() {
  const list = isSelf() ? OWN_PROMPTS : PROMPTS;
  const four = Array.from({ length: Math.min(4, list.length) }, (_, i) => list[(promptStart + i) % list.length]);
  $('#prompts').innerHTML = four.map(p => `<button>${esc(p)}</button>`).join('') +
    `<button class="more" data-more aria-label="Show different questions">↻ Different questions</button>`;
  $('#cDate').textContent = new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
$('#prompts').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.more) { promptStart += 4; return renderPrompts(); }
  $$('#prompts button').forEach(x => x.classList.toggle('active', x === b));
  browserSpeak(b.textContent);
  track('prompt_used');
});

function windTape(seconds) {
  const t = Math.min(1, seconds / TAPE_SECONDS);
  $('#tapeL').setAttribute('r', (19 - 10 * t).toFixed(1));
  $('#tapeR').setAttribute('r', (9 + 10 * t).toFixed(1));
}

$('#recBtn').addEventListener('click', () => (rec.media?.state === 'recording' ? stopRecording() : startRecording()));

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast('This browser can’t record. You can type the story instead.', 'error');
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return toast('The microphone is blocked. Allow it in your browser settings, or type instead.', 'error');
  }
  speechSynthesis.cancel?.();
  const mime = pickMime();
  rec.media = new MediaRecorder(rec.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
  rec.chunks = []; rec.blob = null; rec.edited = false;
  rec.finalText = $('#transcript').value.trim() ? $('#transcript').value.trim() + ' ' : '';
  rec.media.ondataavailable = e => e.data.size && rec.chunks.push(e.data);
  rec.media.onstop = () => {
    rec.blob = new Blob(rec.chunks, { type: rec.media.mimeType || 'audio/webm' });
    rec.stream.getTracks().forEach(t => t.stop());
  };
  rec.media.start(1000);

  if (SR) {
    rec.sr = new SR();
    rec.sr.continuous = true;
    rec.sr.interimResults = true;
    rec.sr.lang = navigator.language || 'en-US';
    rec.sr.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) rec.finalText += r[0].transcript.trim() + ' ';
        else interim += r[0].transcript;
      }
      $('#transcript').value = (rec.finalText + interim).trimStart();
    };
    rec.sr.onend = () => { if (rec.media?.state === 'recording') try { rec.sr.start(); } catch {} };
    try { rec.sr.start(); } catch {}
  }

  $('#deck').classList.add('recording');
  $('#recLabel').textContent = 'Recording. Tap the tape to stop';
  $('#recBtn').setAttribute('aria-label', 'Stop recording');
  $('#recBtn').setAttribute('aria-pressed', 'true');
  rec.start = Date.now();
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.start) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    windTape(s);
  }, 250);
  listenLevel(rec.stream);
}

function stopRecording() {
  rec.stoppedAt = Date.now();
  rec.media?.stop();
  try { rec.sr?.stop(); } catch {}
  rec.sr = null;
  clearInterval(rec.timer);
  rec.ctx?.close?.();
  $('#levelBar').style.width = '0';
  $('#deck').classList.remove('recording');
  $('#recLabel').textContent = 'Got it. Check the words, then keep the story';
  $('#recBtn').setAttribute('aria-label', 'Record more');
  $('#recBtn').setAttribute('aria-pressed', 'false');
  if (!$('#transcript').value.trim()) {
    $('#transcript').placeholder = state.health?.transcription
      ? 'The words will be written out when you keep the story.'
      : 'This browser couldn’t write the words live. Please type what was said.';
  }
}

// Level meter: how loudly they're speaking, so you know the phone is hearing them.
function listenLevel(stream) {
  try {
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = rec.ctx.createAnalyser();
    an.fftSize = 512;
    rec.ctx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.fftSize);
    (function frame() {
      if (rec.media?.state !== 'recording') return;
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      $('#levelBar').style.width = `${Math.min(100, rms * 420)}%`;
      requestAnimationFrame(frame);
    })();
  } catch { /* the meter is a helper, not required */ }
}

$('#transcript').addEventListener('input', () => (rec.edited = true));

$('#clearBtn').addEventListener('click', () => {
  if (rec.media?.state === 'recording') stopRecording();
  $('#transcript').value = '';
  rec.blob = null; rec.edited = false; rec.finalText = '';
  $('#recTime').textContent = '0:00';
  windTape(0);
  $('#recLabel').textContent = 'Tap the tape to start recording';
  $('#saveResult').hidden = true;
  $('#saving').hidden = true;
});

function savingStep(n) {
  $$('#saving li').forEach((li, i) => { li.classList.toggle('done', i < n); li.classList.toggle('doing', i === n); });
}

$('#saveBtn').addEventListener('click', async () => {
  if (rec.media?.state === 'recording') { stopRecording(); await new Promise(r => setTimeout(r, 400)); }
  const text = $('#transcript').value.trim();
  const btn = $('#saveBtn');
  const useAudio = !!rec.blob; // the real recording is always kept
  if (!text && !useAudio) return toast('Record or type a story first.', 'error');

  busy(btn, true);
  $('#saveResult').hidden = true;
  $('#saving').hidden = false;
  savingStep(useAudio ? 0 : 1);
  const step = setTimeout(() => savingStep(1), useAudio ? 2500 : 0);
  try {
    let data;
    if (useAudio) {
      const form = new FormData();
      form.append('audio', rec.blob, `memory.${rec.blob.type.includes('mp4') ? 'm4a' : 'webm'}`);
      form.append('transcription', text);
      form.append('edited', String(rec.edited));
      form.append('person_name', state.person.name);
      form.append('duration', String(Math.round((rec.stoppedAt - rec.start) / 1000) || ''));
      data = await api('/api/record', { method: 'POST', body: form });
    } else {
      data = await api('/api/memories', { method: 'POST', body: { content: text, person_name: state.person.name } });
    }
    clearTimeout(step);
    savingStep(2);
    await new Promise(r => setTimeout(r, 450));
    savingStep(3);
    showSaved(data.memory);
    $('#transcript').value = '';
    $('#transcript').placeholder = DEFAULT_PLACEHOLDER;
    rec.blob = null; rec.edited = false; rec.finalText = '';
    $('#recTime').textContent = '0:00';
    windTape(0);
    $('#recLabel').textContent = 'Tap the tape to record another';
    state.freshId = data.memory.id;
    delete $('#memoryGrid').dataset.examples;
    await loadMemories();
    state.freshId = data.memory.id;
    loadFamily();
  } catch (err) {
    clearTimeout(step);
    $('#saving').hidden = true;
    fail(err);
  } finally { busy(btn, false); }
});

function showSaved(m) {
  const box = $('#saveResult');
  box.innerHTML = `
    <p class="eyebrow">Kept in ${esc(isSelf() ? 'your' : state.person.name + '’s')} album</p>
    <h4>${esc(m.title)}</h4>
    <div class="tags">${[m.memory_date, ...(m.tags || [])].filter(Boolean).map(t => `<span>${esc(t)}</span>`).join('')}</div>
    ${m.summary && m.summary !== m.content ? `<p>${esc(m.summary)}</p>` : ''}
    <div class="row-actions">
      <a class="pill pill-line" href="#home">See it in the album</a>
      <a class="pill pill-accent" href="#ask">Ask about it</a>
    </div>`;
  box.hidden = false;
  setTimeout(() => { $('#saving').hidden = true; }, 600);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Ask ────────────────────────────────────────────────────────
function renderSuggestions() {
  if (!state.person) return;
  const p = isSelf() ? 'I' : state.person.name;
  const recipe = state.memories.find(m => m.category === 'recipe');
  const dated = state.memories.find(m => yearOf(m.memory_date));
  const qs = isSelf()
    ? ['What advice did I leave?', 'What recipes did I record?', 'What was my childhood like?']
    : [
        recipe ? `How do I make ${recipe.title.toLowerCase().replace(/^(the|my|a|nani's|grandma's)\s+/, '')}?` : `What did ${p} love to cook?`,
        dated ? `What happened in ${yearOf(dated.memory_date)}?` : `Where did ${p} grow up?`,
        `What advice did ${p} give?`
      ];
  $('#suggestions').innerHTML = $('#chat').children.length ? '' : qs.map(q => `<button>${esc(q)}</button>`).join('');
}
$('#suggestions').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) { $('#chatInput').value = b.textContent; $('#chatForm').requestSubmit(); }
});

$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#chatInput').value.trim();
  if (!q || !state.person) return;
  $('#chatInput').value = '';
  $('#suggestions').innerHTML = '';
  addMsg('user', esc(q));
  const name = state.person.name;
  const bubble = addMsg('bot', `<p class="who">${esc(name)}</p><span class="typing"><span></span><span></span><span></span></span>`);
  try {
    const speak = $('#speakToggle').checked;
    const r = await api('/api/chat', { method: 'POST', body: { question: q, person_name: name } });
    const who = isSelf() ? 'yourself' : name;
    const quotes = r.sources.filter(s => s.quote).map((s, i) => `
      <figure class="quote">
        <blockquote>“${esc(s.quote)}”</blockquote>
        <div class="quote-actions">
          ${s.voice ? `<button class="hear" data-i="${i}">▶ Hear ${esc(who)} say it</button>` : ''}
          <button class="src" data-id="${s.id}">From “${esc(s.title)}”${s.memory_date ? ` · ${esc(s.memory_date)}` : ''}</button>
        </div>
      </figure>`).join('');
    bubble.innerHTML = `
      <p class="who">${esc(name)}</p>
      <p class="answer">${esc(r.answer)}</p>
      ${r.grounded && quotes ? `<p class="quote-label">In ${esc(isSelf() ? 'your' : 'their')} own words</p>${quotes}` : ''}
      ${!r.grounded ? `<div class="not-yet">${esc(isSelf() ? 'You haven’t' : name + ' hasn’t')} talked about this yet. It could be a great question for the next recording.
         <div class="row-actions"><button class="pill pill-accent" data-record>Record this story</button></div></div>` : ''}
      `;
    const voiced = r.sources.filter(s => s.quote);
    bubble.querySelectorAll('.quote .hear').forEach(b => (b.onclick = () => {
      const v = voiced[+b.dataset.i].voice;
      playVoice(v.url, v.start, v.end, b);
      track('clip_played');
    }));
    bubble.querySelectorAll('.quote .src').forEach(b => (b.onclick = async () => {
      const m = state.memories.find(x => x.id === b.dataset.id) || await api(`/api/memories/${b.dataset.id}`).catch(() => null);
      openMemory(m);
    }));
    bubble.querySelector('[data-record]')?.addEventListener('click', () => {
      location.hash = 'record';
      setTimeout(() => {
        $('#prompts').insertAdjacentHTML('afterbegin', `<button class="active">${esc(q)}</button>`);
      }, 50);
    });
    const first = bubble.querySelector('.quote .hear');
    if (speak && first) first.click();
  } catch (err) {
    bubble.innerHTML = `<p class="answer">Sorry, that didn’t work. ${esc(err.message)}</p>`;
  }
  bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
});

function addMsg(role, html) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = html;
  $('#chat').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

// ── Keep forever ───────────────────────────────────────────────
async function loadStory(force = false) {
  const t = $('#tribute');
  if (!state.person) return;
  if (!force && t.dataset.for === state.person.name && t.dataset.count == state.memories.length) return;
  if (!state.memories.length) {
    t.textContent = `Once ${isSelf() ? 'you’ve' : state.person.name + ' has'} recorded a few stories, a short tribute will appear here, written only from their words.`;
    return;
  }
  t.classList.add('loading');
  t.textContent = 'Reading through their stories…';
  try {
    const r = await api(`/api/summary/${encodeURIComponent(state.person.name)}`);
    t.textContent = r.summary;
    t.dataset.for = state.person.name;
    t.dataset.count = r.memory_count;
  } catch {
    t.textContent = 'Couldn’t write the tribute right now. Try again in a moment.';
  }
  t.classList.remove('loading');
}
$('#refreshStory').addEventListener('click', () => loadStory(true));

async function renderVoiceStatus() {
  const el = $('#voiceStatus');
  if (!el || !state.person) return;
  try {
    const v = await api(`/api/persons/${encodeURIComponent(state.person.name)}/voice`);
    const who = isSelf() ? 'your' : `${state.person.name}’s`;
    el.innerHTML = v.recordings
      ? `<b>●</b> ${v.minutes < 1 ? 'Under a minute' : `${v.minutes} minutes`} of ${esc(who)} real voice kept, across ${v.recordings} ${v.recordings === 1 ? 'recording' : 'recordings'}.`
      : `No recordings yet. Every story you record keeps ${esc(who)} real voice.`;
  } catch { el.textContent = ''; }
}

$('#exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(`/api/export/${encodeURIComponent(state.person.name)}`, { headers: { 'X-Family-Key': state.key } });
    const blob = await res.blob();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `memoria-${state.person.name}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch { toast('Couldn’t download right now.', 'error'); }
});

$('#printBtn').addEventListener('click', () => {
  if (state.family?.plan !== 'lifetime') return openUpgrade('The keepsake book is part of Lifetime.');
  const p = state.person.name;
  const sorted = [...state.memories].sort((a, b) => (yearOf(a.memory_date) || 9999) - (yearOf(b.memory_date) || 9999));
  $('#keepsake').innerHTML = `
    <div class="cover"><p>The stories of</p><h1>${esc(p)}</h1><p>${sorted.length} stories, in their own words · kept with Memoria</p></div>
    ${sorted.map(m => `<article><h2>${esc(m.title)}</h2><small>${esc(m.memory_date || formatDate(m.created_at))}</small><p>${esc(m.content)}</p></article>`).join('')}`;
  track('print');
  setTimeout(() => window.print(), 100);
});

async function copyLink(btn) {
  try {
    await navigator.clipboard.writeText(privateLink());
    toast('Private link copied. Keep it within the family.');
  } catch {
    prompt('Copy your private link:', privateLink());
  }
  track('share_link');
}
$('#shareLinkBtn').addEventListener('click', e => {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    navigator.share({ title: 'Our family stories on Memoria', text: 'Add your stories to our family album:', url: privateLink() }).catch(() => {});
    track('share_link');
  } else copyLink(e.target);
});
$('#copyLinkBtn').addEventListener('click', e => copyLink(e.target));
$('#emailLinkBtn').addEventListener('click', () => {
  location.href = `mailto:?subject=${encodeURIComponent('My Memoria family link')}&body=${encodeURIComponent(`Keep this safe. It opens our family's stories on any device:\n\n${privateLink()}`)}`;
});
$('#ownerForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    state.family = { ...state.family, ...(await api('/api/family', { method: 'PATCH', body: { owner_name: $('#ownerInput').value } })) };
    renderPlan();
    toast('Saved');
  } catch (err) { fail(err); }
});

// ── Lifetime ───────────────────────────────────────────────────
function openUpgrade(reason) {
  closeSheets();
  setTimeout(() => {
    $('#uReason').textContent = reason || 'Everything you need to keep the whole family’s stories.';
    $('#upgradeSheet').hidden = false;
  }, 240);
  track('upgrade_viewed', { reason: (reason || 'menu').slice(0, 60) });
}
document.addEventListener('click', e => { if (e.target.closest('[data-upgrade]')) openUpgrade(); });

$('#buyBtn').addEventListener('click', async () => {
  const btn = $('#buyBtn');
  busy(btn, true);
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST' });
    location.href = url;
  } catch (err) { fail(err); busy(btn, false); }
});

async function waitForLifetime() {
  toast('Thank you! Unlocking Lifetime…');
  for (let i = 0; i < 20; i++) {
    await loadFamily().catch(() => {});
    if (state.family?.plan === 'lifetime') return toast('Lifetime unlocked. Every story, for everyone.');
    await new Promise(r => setTimeout(r, 2500));
  }
  toast('Payment received. Lifetime will switch on in a minute or two.');
}

// ── Landing demo video: appears once the file exists, plays only while on screen ──
(function demoVideo() {
  const v = $('#demoVideo'), section = $('#demo'), btn = $('#demoSound');
  if (!v) return;
  v.addEventListener('loadedmetadata', () => { section.hidden = false; }, { once: true });
  v.addEventListener('error', () => { section.hidden = true; $('#demoLink')?.setAttribute('href', '#how'); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting) v.play().catch(() => {}); else v.pause();
    }, { threshold: 0.5 }).observe(v);
  }
  btn.addEventListener('click', () => {
    v.muted = !v.muted;
    if (!v.muted) { v.currentTime = 0; v.play().catch(() => {}); track('demo_sound'); }
    btn.textContent = v.muted ? 'Turn sound on' : 'Sound on';
    btn.setAttribute('aria-pressed', String(!v.muted));
  });
})();

// ── Reveal on scroll ───────────────────────────────────────────
let revealer;
function observeReveals() {
  if (!('IntersectionObserver' in window)) return document.body.classList.add('no-io');
  revealer ||= new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  $$('.reveal:not(.in)').forEach(el => revealer.observe(el));
}

// ── Boot ───────────────────────────────────────────────────────
async function boot() {
  takeKeyFromUrl();
  state.key = lsGet('memoria.key');
  const paid = new URLSearchParams(location.search).has('paid');
  if (paid) history.replaceState(null, '', location.pathname + location.hash);
  route();
  state.health = await api('/api/health').catch(() => null);
  $('#sttHint').textContent = state.health?.transcription ? 'written out word for word when you keep the story' : SR ? 'written out live as they talk' : 'type below';
  if (!state.key) return;
  try {
    await loadFamily();
    await loadPersons();
    route(); // the bare address keeps showing the homepage
    if (paid) waitForLifetime();
  } catch (err) { fail(err); }
}
boot();
