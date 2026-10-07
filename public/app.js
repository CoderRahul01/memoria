/* Memoria — frontend */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  person: { name: 'Grandpa', relationship: 'grandfather' },
  persons: [],
  memories: [],
  filter: 'all',
  health: null,
  samples: [],
  current: null
};

const CATEGORY_SURFACE = {
  recipe: 'c-parchment', advice: 'c-parchment',
  story: 'c-blue', family: 'c-blue', event: 'c-blue',
  place: 'c-sage', other: 'c-sage'
};

const FILTER_LABELS = { all: 'Everything', recipe: 'Recipes', story: 'Stories', advice: 'Advice', family: 'Family', event: 'Events', place: 'Places', other: 'Other' };

const PROMPTS = [
  'What’s a recipe only you know how to make?',
  'Tell me about the day you got married.',
  'What was your childhood home like?',
  'What advice would you give your grandchildren?',
  'Who was your best friend growing up?',
  'What was your first job, and what did it pay?',
  'What’s the hardest thing you ever went through?',
  'Which festival do you remember most, and why?'
];

// ── API helper ─────────────────────────────────────────────────
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(path, {
    ...opts,
    headers: isForm ? undefined : { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: isForm ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3600);
}

function busy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = name => (name || '?').trim()[0].toUpperCase();

// ── Routing ────────────────────────────────────────────────────
const VIEWS = ['home', 'record', 'ask', 'story'];
function route() {
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  const swap = () => VIEWS.forEach(v => ($(`#view-${v}`).hidden = v !== view));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduce && route.booted) {
    const vt = document.startViewTransition(swap);
    vt.ready.catch(() => {}); vt.finished.catch(() => {});
  }
  else swap();
  route.booted = true;
  observeReveals();
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === view));
  window.scrollTo({ top: 0 });
  if (view === 'story') loadStory();
  if (view === 'ask') renderSuggestions();
}
window.addEventListener('hashchange', route);

// ── Persons ────────────────────────────────────────────────────
async function loadPersons() {
  state.persons = await api('/api/persons').catch(() => []);
  const saved = localStorageGet('memoria.person');
  const found = state.persons.find(p => p.name === saved) || state.persons[0];
  if (found) setPerson(found, false);
}

function setPerson(p, reload = true) {
  state.person = p;
  localStorageSet('memoria.person', p.name);
  $('#chipName').textContent = p.name;
  $('#chipAvatar').textContent = initial(p.name);
  $('#heroName').textContent = p.name;
  $('#storyTitle').textContent = p.name;
  $$('.pname').forEach(el => (el.textContent = p.name));
  $('#chat').innerHTML = '';
  renderVoiceStatus();
  loadAndRenderPresets();
  if (reload) { loadMemories(); if (!$('#view-story').hidden) loadStory(); }
}

function openPersonSheet() {
  $('#personList').innerHTML = state.persons.map((p, i) => `
    <li><button data-i="${i}" class="${p.name === state.person.name ? 'current' : ''}">
      <span class="avatar">${esc(initial(p.name))}</span>
      <span><b>${esc(p.name)}</b><small>${esc(p.relationship || '')}${p.relationship ? ' · ' : ''}${p.memory_count || 0} memories${p.voice_id ? ' · voice ready' : ''}</small></span>
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
    await loadPersons();
    setPerson(state.persons.find(x => x.name === p.name) || p);
    closeSheets();
    toast(`Now collecting ${p.name}’s memories`);
  } catch (err) { toast(err.message, 'error'); }
});

// ── Memories ───────────────────────────────────────────────────
async function loadMemories() {
  const q = $('#searchInput').value.trim();
  const params = new URLSearchParams({ person: state.person.name });
  if (q) params.set('q', q);
  try {
    state.memories = await api(`/api/memories?${params}`);
  } catch (err) {
    toast('Couldn’t load memories. Check your connection.', 'error');
    state.memories = [];
  }
  if (!q) updateStats(state.memories);
  renderFilters();
  renderMemories();
}

function updateStats(mems) {
  countTo($('#statCount'), mems.length);
  countTo($('#statRecipes'), mems.filter(m => m.category === 'recipe').length);
  const names = new Set();
  mems.forEach(m => (m.people || []).forEach(n => names.add(String(n).trim().toLowerCase())));
  countTo($('#statPeople'), Math.min(names.size, 99));
}

// Numbers glide to their value with the same expo-out curve as everything else.
function countTo(el, target) {
  const from = +el.textContent || 0;
  if (from === target) return;
  const start = performance.now(), dur = 1100;
  const ease = t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
  (function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = Math.round(from + (target - from) * ease(t));
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

// Elements marked .reveal slide up the first time they scroll into view.
let revealer;
function observeReveals() {
  if (!('IntersectionObserver' in window)) return document.body.classList.add('no-io');
  revealer ||= new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  $$('.reveal:not(.in)').forEach(el => revealer.observe(el));
}

function renderFilters() {
  const cats = ['all', ...new Set(state.memories.map(m => m.category))];
  if (!cats.includes(state.filter)) state.filter = 'all';
  $('#filters').innerHTML = cats.length > 2 ? cats.map(c =>
    `<button role="tab" aria-selected="${c === state.filter}" data-cat="${c}">${FILTER_LABELS[c] || c}</button>`
  ).join('') : '';
}

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  state.filter = b.dataset.cat;
  renderFilters();
  renderMemories();
});

function renderMemories() {
  const list = state.filter === 'all' ? state.memories : state.memories.filter(m => m.category === state.filter);
  const searching = !!$('#searchInput').value.trim();
  $('#emptyState').hidden = list.length > 0 || searching;
  $('#memoryGrid').innerHTML = list.length ? list.map((m, i) => `
    <button class="mcard ${CATEGORY_SURFACE[m.category] || 'c-blue'}" data-id="${m.id}" style="--i:${i}">
      <span class="meta"><span>${esc(m.category)}</span><span>${esc(m.memory_date || formatDate(m.created_at))}</span></span>
      <h3>${esc(m.title)}</h3>
      <p>${esc(m.content)}</p>
      ${m.tags?.length ? `<span class="tags">${m.tags.slice(0, 4).map(t => `<span>${esc(t)}</span>`).join('')}</span>` : ''}
    </button>`).join('')
    : searching ? `<p class="muted">No memories mention “${esc($('#searchInput').value)}” yet. Try asking about it in the Ask tab.</p>` : '';
}

$('#memoryGrid').addEventListener('click', e => {
  const card = e.target.closest('.mcard');
  if (card) openMemory(state.memories.find(m => m.id === card.dataset.id));
});

let searchTimer;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMemories, 250);
});

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Memory sheet ───────────────────────────────────────────────
function openMemory(m) {
  if (!m) return;
  state.current = m;
  $('#mMeta').textContent = [m.category, m.memory_date, `saved ${formatDate(m.created_at)}`].filter(Boolean).join(' · ');
  $('#mTitle').textContent = m.title;
  $('#mTags').innerHTML = (m.tags || []).map(t => `<span>${esc(t)}</span>`).join('');
  $('#mContent').textContent = m.content;
  const audio = $('#mAudio');
  audio.pause(); audio.hidden = true; audio.removeAttribute('src');
  $('#memorySheet').hidden = false;
}

$('#mPlay').addEventListener('click', async () => {
  const m = state.current, btn = $('#mPlay');
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); btn.textContent = 'Listen'; return; }
  busy(btn, true);
  try {
    const { tts_url } = await api('/api/speak', { method: 'POST', body: { memory_id: m.id } });
    if (tts_url) {
      const audio = $('#mAudio');
      audio.src = tts_url; audio.hidden = false;
      await audio.play().catch(() => {});
    } else {
      browserSpeak(m.content, btn);
    }
  } catch (err) {
    browserSpeak(m.content, btn);
  } finally { busy(btn, false); }
});

function browserSpeak(text, btn) {
  if (!('speechSynthesis' in window)) return toast('This browser can’t read aloud.', 'error');
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.95;
  if (btn) { btn.textContent = 'Stop'; u.onend = u.onerror = () => (btn.textContent = btn.dataset.label || 'Listen'); }
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

$('#mDelete').addEventListener('click', async () => {
  const m = state.current;
  const btn = $('#mDelete');
  if (btn.dataset.confirm !== m.id) {
    btn.dataset.confirm = m.id;
    btn.textContent = 'Tap again to delete';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete'; }, 3000);
    return;
  }
  try {
    await api(`/api/memories/${m.id}`, { method: 'DELETE' });
    btn.dataset.confirm = ''; btn.textContent = 'Delete';
    closeSheets();
    toast('Memory deleted');
    loadMemories();
  } catch (err) { toast(err.message, 'error'); }
});

function closeSheets() {
  $$('.sheet-backdrop:not([hidden])').forEach(s => {
    s.classList.add('closing');
    setTimeout(() => { s.hidden = true; s.classList.remove('closing'); }, 420);
  });
  $('#mAudio').pause();
  speechSynthesis.cancel?.();
}
$$('.sheet-backdrop').forEach(bd => bd.addEventListener('click', e => {
  if (e.target === bd || e.target.closest('[data-close]')) closeSheets();
}));
document.addEventListener('keydown', e => e.key === 'Escape' && closeSheets());
$('#personChip').addEventListener('click', openPersonSheet);

// ── Recording ──────────────────────────────────────────────────
const DEFAULT_PLACEHOLDER = document.querySelector('#transcript').placeholder;
const rec = { media: null, chunks: [], blob: null, stream: null, sr: null, timer: null, start: 0, edited: false, finalText: '', ctx: null };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

function renderPrompts() {
  $('#prompts').innerHTML = PROMPTS.map(p => `<button>${esc(p)}</button>`).join('');
}
$('#prompts').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#prompts button').forEach(x => x.classList.toggle('active', x === b));
  browserSpeak(b.textContent);
});

$('#recBtn').addEventListener('click', () => (rec.media?.state === 'recording' ? stopRecording() : startRecording()));

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast('Recording isn’t supported in this browser. You can type the memory instead.', 'error');
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return toast('Microphone access was blocked. Allow it in your browser settings, or type instead.', 'error');
  }
  speechSynthesis.cancel?.();
  const mime = pickMime();
  rec.media = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
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

  document.querySelector('.recorder').classList.add('recording');
  $('#recLabel').textContent = 'Listening… tap to stop';
  $('#recBtn').setAttribute('aria-label', 'Stop recording');
  rec.start = Date.now();
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.start) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  drawWave(rec.stream);
}

function stopRecording() {
  rec.media?.stop();
  try { rec.sr?.stop(); } catch {}
  rec.sr = null;
  clearInterval(rec.timer);
  rec.ctx?.close?.();
  document.querySelector('.recorder').classList.remove('recording');
  $('#recLabel').textContent = 'Recorded. Check the words, then save';
  $('#recBtn').setAttribute('aria-label', 'Record again');
  if (!$('#transcript').value.trim()) {
    $('#transcript').placeholder = state.health?.voice
      ? 'Your recording will be transcribed when you save.'
      : 'This browser couldn’t transcribe live. Please type what was said.';
  }
}

function drawWave(stream) {
  const canvas = $('#wave'), g = canvas.getContext('2d');
  try {
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = rec.ctx.createAnalyser();
    an.fftSize = 128;
    rec.ctx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    (function frame() {
      if (rec.media?.state !== 'recording') return g.clearRect(0, 0, canvas.width, canvas.height);
      an.getByteFrequencyData(data);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 40, w = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor(i * data.length / bars)] / 255;
        const h = Math.max(3, v * canvas.height);
        g.fillStyle = `rgba(255, ${89 + Math.round(v * 80)}, 36, ${0.35 + v * 0.65})`;
        g.beginPath();
        g.roundRect?.(i * w + w * 0.3, (canvas.height - h) / 2, w * 0.4, h, 3) ?? g.rect(i * w + w * 0.3, (canvas.height - h) / 2, w * 0.4, h);
        g.fill();
      }
      requestAnimationFrame(frame);
    })();
  } catch { /* waveform is decorative */ }
}

$('#transcript').addEventListener('input', () => (rec.edited = true));

$('#clearBtn').addEventListener('click', () => {
  if (rec.media?.state === 'recording') stopRecording();
  $('#transcript').value = '';
  rec.blob = null; rec.edited = false; rec.finalText = '';
  $('#recTime').textContent = '0:00';
  $('#recLabel').textContent = 'Tap to record';
  $('#saveResult').hidden = true;
});

$('#saveBtn').addEventListener('click', async () => {
  if (rec.media?.state === 'recording') { stopRecording(); await new Promise(r => setTimeout(r, 400)); }
  const text = $('#transcript').value.trim();
  const btn = $('#saveBtn');
  // Send the audio for server-side transcription only if the user hasn't hand-corrected the text.
  const useAudio = rec.blob && state.health?.voice && !rec.edited;
  if (!text && !useAudio) return toast('Record or type a memory first.', 'error');

  busy(btn, true);
  btn.firstChild && (btn.dataset.label = 'Save memory');
  try {
    let data;
    if (useAudio) {
      const form = new FormData();
      form.append('audio', rec.blob, `memory.${rec.blob.type.includes('mp4') ? 'm4a' : 'webm'}`);
      form.append('transcription', text);
      form.append('person_name', state.person.name);
      data = await api('/api/record', { method: 'POST', body: form });
    } else {
      data = await api('/api/memories', { method: 'POST', body: { content: text, person_name: state.person.name } });
    }
    showSaved(data.memory);
    $('#transcript').value = '';
    $('#transcript').placeholder = DEFAULT_PLACEHOLDER;
    rec.blob = null; rec.edited = false; rec.finalText = '';
    $('#recTime').textContent = '0:00';
    $('#recLabel').textContent = 'Tap to record another';
    loadMemories();
  } catch (err) {
    toast(err.message, 'error');
  } finally { busy(btn, false); }
});

function showSaved(m) {
  const box = $('#saveResult');
  box.innerHTML = `
    <p class="eyebrow">Saved to ${esc(state.person.name)}’s collection</p>
    <h4>${esc(m.title)}</h4>
    <div class="tags">${[m.category, m.memory_date, ...(m.tags || [])].filter(Boolean).map(t => `<span>${esc(t)}</span>`).join('')}</div>
    ${m.summary && m.summary !== m.content ? `<p>${esc(m.summary)}</p>` : ''}
    <div class="row-actions">
      <a class="pill pill-slate" href="#ask">Ask about it</a>
      <button class="pill pill-ember" id="openSaved">Open memory</button>
    </div>`;
  box.hidden = false;
  $('#openSaved').onclick = () => openMemory(m);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Ask ────────────────────────────────────────────────────────
function renderSuggestions() {
  const p = state.person.name;
  const recipes = state.memories.filter(m => m.category === 'recipe');
  const qs = [
    recipes[0] ? `How do I make ${recipes[0].title.toLowerCase().replace(/^(the|my|a)\s+/, '')}?` : `What did ${p} love to cook?`,
    `What advice did ${p} give about life?`,
    `Where did ${p} grow up?`,
    `Tell me a funny story`
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
  if (!q) return;
  $('#chatInput').value = '';
  $('#suggestions').innerHTML = '';
  addMsg('user', esc(q));
  const typing = addMsg('bot', '<span class="typing"><span></span><span></span><span></span></span>');
  try {
    const speak = $('#speakToggle').checked;
    const r = await api('/api/chat', { method: 'POST', body: { question: q, person_name: state.person.name, speak } });
    typing.innerHTML = `
      <p class="answer">${esc(r.answer)}</p>
      ${r.sources?.length ? `<div class="sources"><small>From</small>${r.sources.slice(0, 3).map(s => `<button data-id="${s.id}">${esc(s.title)}</button>`).join('')}</div>` : ''}
      <button class="listen">Listen again</button>`;
    typing.querySelector('.listen').onclick = () => r.tts_url ? new Audio(r.tts_url).play() : browserSpeak(r.answer);
    typing.querySelectorAll('.sources button').forEach(b => (b.onclick = async () => {
      const m = state.memories.find(x => x.id === b.dataset.id) || await api(`/api/memories/${b.dataset.id}`).catch(() => null);
      openMemory(m);
    }));
    if (speak) r.tts_url ? new Audio(r.tts_url).play().catch(() => {}) : browserSpeak(r.answer);
  } catch (err) {
    typing.innerHTML = `<p class="answer">Sorry, that didn’t work: ${esc(err.message)}</p>`;
  }
  typing.scrollIntoView({ behavior: 'smooth', block: 'end' });
});

function addMsg(role, html) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = html;
  $('#chat').appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

// ── Story ──────────────────────────────────────────────────────
async function loadStory(force = false) {
  const t = $('#tribute');
  if (!force && t.dataset.for === state.person.name && t.dataset.count == state.memories.length) return;
  t.textContent = 'Reading through their memories…';
  try {
    const r = await api(`/api/summary/${encodeURIComponent(state.person.name)}`);
    t.textContent = r.summary || `No memories yet. Once ${state.person.name} has recorded a few, a short tribute will appear here.`;
    t.dataset.for = state.person.name;
    t.dataset.count = r.memory_count;
  } catch {
    t.textContent = 'Couldn’t write the tribute right now. Try again in a moment.';
  }
  renderEngines();
}
$('#refreshStory').addEventListener('click', () => loadStory(true));

function renderVoiceStatus() {
  const el = $('#voiceStatus');
  if (!state.health || !el) return;
  const currentVoiceId = state.person.voice_id || state.health.default_voice;
  const presets = state.voiceData?.presets || [];
  const preset = presets.find(p => p.id === currentVoiceId);

  if (!state.health.voice) {
    el.innerHTML = 'Voice cloning isn’t switched on for this server yet. For now, memories are read aloud by your device’s built-in voice.';
  } else if (state.person.voice_id && !preset) {
    el.innerHTML = `<b>●</b> ${esc(state.person.name)}’s custom cloned voice is ready. Every memory will play in it.`;
  } else if (preset) {
    el.innerHTML = `<b>●</b> Active storyteller voice: <strong>${esc(preset.name)}</strong> (${esc(preset.tag)}). Ready for playback.`;
  } else {
    el.innerHTML = `Using default warm storyteller voice (Grandma Clo). Or record 1–3 samples to clone their own voice.`;
  }

  const heroVoice = $('#heroVoiceLabel');
  if (heroVoice) {
    heroVoice.textContent = preset ? preset.name : (state.person.voice_id ? 'Cloned Voice' : 'Grandma Clo');
  }
  updateCloneBtn();
}

async function loadAndRenderPresets() {
  const container = $('#presetVoicesGrid');
  if (!container) return;
  try {
    const data = await api('/api/voices');
    state.voiceData = data;
    const presets = data.presets || [];
    const currentVoiceId = state.person.voice_id || data.default_voice_id;

    const activePreset = presets.find(p => p.id === currentVoiceId);
    const heroVoice = $('#heroVoiceLabel');
    if (heroVoice) {
      heroVoice.textContent = activePreset ? activePreset.name : (state.person.voice_id ? 'Cloned Voice' : 'Grandma Clo');
    }

    container.innerHTML = presets.map(p => {
      const isSelected = p.id === currentVoiceId;
      return `
        <button type="button" class="preset-voice-card ${isSelected ? 'active' : ''}" data-voice-id="${esc(p.id)}">
          <div class="preset-voice-head">
            <span>${esc(p.name)}</span>
            <span class="preset-voice-tag">${esc(p.tag)}</span>
          </div>
          <p class="preset-voice-desc">${esc(p.description)}</p>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.preset-voice-card').forEach(card => {
      card.addEventListener('click', async () => {
        const voiceId = card.dataset.voiceId;
        try {
          await api(`/api/persons/${encodeURIComponent(state.person.name)}/voice`, {
            method: 'POST',
            body: { voice_id: voiceId }
          });
          state.person.voice_id = voiceId;
          const chosen = presets.find(p => p.id === voiceId);
          toast(`Voice set to ${chosen ? chosen.name : 'preset'}`);
          renderVoiceStatus();
          loadAndRenderPresets();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    console.warn('Failed to load voice presets:', err);
  }
}

function renderEngines() {
  const h = state.health;
  if (!h) return;
  const ai = h.ai || {};
  const items = [
    [!!h.backboard, `<b>Backboard</b> keeps each person's memory and answers with ${h.backboard ? esc(h.backboard) : 'Gemma'}, all through one API key`],
    [ai.tinker, `<b>Tinker</b> serves an open-weight backup model${ai.tinkerModel ? ` (${esc(ai.tinkerModel)})` : ''} if Backboard is unreachable`],
    [h.voice, `<b>ElevenLabs</b> for accurate transcription in 90+ languages, plus voice cloning & presets`],
    [true, `<b>Render</b> runs this app. Raw audio is deleted as soon as it's transcribed`]
  ];
  $('#engineList').innerHTML = items.map(([on, txt]) => `<li class="${on ? 'on' : ''}">${txt}${on ? '' : ' <small>(not set up)</small>'}</li>`).join('') +
    `<li class="on">Writing titles and tags with: <b>${esc(engineLabel(ai.engine))}</b></li>` +
    `<li class="on">Answering questions with: <b>${esc(h.backboard ? engineLabel('backboard:' + h.backboard) : engineLabel(ai.engine))}</b></li>`;

  const heroAi = $('#heroAiLabel');
  if (heroAi) {
    heroAi.textContent = h.backboard ? 'Gemma 4' : ai.tinker ? 'Tinker' : 'Heuristic Rules';
  }
}

function engineLabel(engine = 'heuristic') {
  if (engine.startsWith('backboard:')) return `Gemma through Backboard (${engine.slice(10)})`;
  if (engine.startsWith('tinker:')) return `Open model on Tinker (${engine.slice(7)})`;
  return 'Memoria’s built-in rules. Add a Backboard key for full AI answers';
}

// Voice samples
$('#sampleFiles').addEventListener('change', e => {
  [...e.target.files].forEach(f => state.samples.push(f));
  e.target.value = '';
  renderSamples();
});

const sampleRec = { media: null, chunks: [], timer: null };
$('#sampleRecBtn').addEventListener('click', async () => {
  const btn = $('#sampleRecBtn');
  if (sampleRec.media?.state === 'recording') return sampleRec.media.stop();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    sampleRec.media = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    sampleRec.chunks = [];
    sampleRec.media.ondataavailable = e => e.data.size && sampleRec.chunks.push(e.data);
    sampleRec.media.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(sampleRec.timer);
      const type = sampleRec.media.mimeType || 'audio/webm';
      state.samples.push(new File(sampleRec.chunks, `sample-${state.samples.length + 1}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type }));
      btn.textContent = 'Record a sample';
      renderSamples();
    };
    sampleRec.media.start();
    const start = Date.now();
    sampleRec.timer = setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      btn.textContent = `Stop · ${s}s`;
      if (s >= 120) sampleRec.media.stop();
    }, 500);
  } catch { toast('Microphone access was blocked.', 'error'); }
});

function renderSamples() {
  $('#sampleList').innerHTML = state.samples.map((f, i) =>
    `<li><span>${esc(f.name)} · ${(f.size / 1024).toFixed(0)} KB</span><button data-i="${i}" aria-label="Remove">×</button></li>`).join('');
  updateCloneBtn();
}
$('#sampleList').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (b) { state.samples.splice(+b.dataset.i, 1); renderSamples(); }
});
$('#consentBox').addEventListener('change', updateCloneBtn);
function updateCloneBtn() {
  $('#cloneBtn').disabled = !(state.health?.voice && state.samples.length && $('#consentBox').checked);
}

$('#cloneBtn').addEventListener('click', async () => {
  const btn = $('#cloneBtn');
  const form = new FormData();
  form.append('person_name', state.person.name);
  state.samples.forEach(f => form.append('samples', f, f.name));
  busy(btn, true);
  try {
    const r = await api('/api/clone-voice', { method: 'POST', body: form });
    state.person.voice_id = r.voice_id;
    state.samples = [];
    renderSamples();
    renderVoiceStatus();
    toast(`${state.person.name}’s voice is ready`);
  } catch (err) { toast(err.message, 'error'); }
  finally { busy(btn, false); updateCloneBtn(); }
});

$('#exportBtn').addEventListener('click', () => {
  location.href = `/api/export/${encodeURIComponent(state.person.name)}`;
});
$('#printBtn').addEventListener('click', async () => {
  location.hash = 'home';
  state.filter = 'all';
  $('#searchInput').value = '';
  await loadMemories();
  setTimeout(() => window.print(), 300);
});

// ── Sample data (lets a new visitor see the value in seconds) ──
const SAMPLES = [
  'My biryani secret is simple. Fry the onions slowly until they are dark brown, almost burnt, and save that oil. Use one teaspoon of shahi jeera and two black cardamoms, never green. Soak the rice exactly forty minutes. Your grandmother Kamala taught me that in 1968.',
  'In 1971 I took the night train from Lucknow to Bombay with only forty rupees in my pocket. I slept on the station for three nights before Mr. Desai gave me a job at his printing press. I swept floors first. Within five years I was running the press.',
  'Always pay back a favour before you ask for another one. And never sign anything the same day someone gives it to you. Sleep on it. That one rule saved our shop twice.',
  'We were married on a rainy day in February 1965. Kamala wore her mother’s red sari and the electricity went out halfway through the ceremony, so the whole wedding was lit with lanterns. Everyone said it was the most beautiful wedding in the village.'
];
$('#seedBtn').addEventListener('click', async () => {
  const btn = $('#seedBtn');
  busy(btn, true);
  try {
    for (const content of SAMPLES) {
      await api('/api/memories', { method: 'POST', body: { content, person_name: state.person.name } });
    }
    toast('Added 4 sample memories. Now try the Ask tab.');
    loadMemories();
  } catch (err) { toast(err.message, 'error'); }
  finally { busy(btn, false); }
});

// ── Storage helpers (may be unavailable in private mode) ───────
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ── Boot ───────────────────────────────────────────────────────
async function boot() {
  renderPrompts();
  route();
  state.health = await api('/api/health').catch(() => null);
  $('#sttHint').textContent = state.health?.voice ? 'transcribed by ElevenLabs on save' : SR ? 'live transcription on this device' : 'type below';
  await loadPersons();
  await loadMemories();
  await loadAndRenderPresets();
  renderVoiceStatus();
  renderEngines();
  renderSuggestions();
}
boot();
