# Memoria

**The stories only they know, kept in their own words.**

Press record and let them talk. Memoria transcribes word-for-word, preserves the genuine audio recording, and allows the entire family to ask questions years later—hearing the answer in their loved one's authentic voice.

**Live Web App:** https://memoria-family.vercel.app · **API Service:** https://memoria-qlji.onrender.com · **Demo Video (2 min):** https://youtu.be/At-VTzgk2JI

---

## Technical Stack & AI Pipeline

| Component | Technology | Role |
|---|---|---|
| **AI Intelligence** | **Google Gemini 2.5 Flash** (Primary) + Gemma 4 (OpenRouter) + Tinker AI | Sub-second extraction of titles, tags, and timeline years without hallucination |
| **Speech-to-Text** | **ElevenLabs Scribe** (with Web Speech API fallback) | Word-level timestamps in 90+ languages |
| **Backend & Edge** | **Node.js + Express** (Render) | Cryptographic link signing, range-seeking audio streaming, rate limiting |
| **Database** | **Neon PostgreSQL** | Multi-tenant family partition, audio BYTEA storage, and event logging |
| **Frontend** | **Vanilla ES6 + HTML5 Web Audio** (Vercel) | Zero-friction PWA with interactive cassette deck and QR print engine |
| **Monetization** | **Dodo Payments** | Cryptographic webhook receiver for $19 Lifetime family unlocks |

---

## Key Features

- **Question links for elders:** Send one question on WhatsApp. They open it on their own phone, hear it read out, tap once and answer. No app, no sign-up. The link can only record answers for that one person, it can't open the album, and an elder's answer is never turned away for a plan limit.
- **A follow-up, like a real interviewer:** Right after an elder answers, Memoria reads what they said and asks one natural follow-up on the same screen, in their language. Their next answer is filed under that question.
- **Ask the whole family, two versions kept:** Ask across everyone's stories. When Mama says 1970 and Nani says 1968, you get both, each with their own quote and voice. Memoria never blends family memory into one "AI truth".
- **Family know-how:** Remedies, rituals and how the house runs get their own category and prompts, so it's useful every day, not just for nostalgia.
- **Next questions:** After every story, Memoria suggests follow-ups on the people and places already mentioned, plus the parts of their life nobody has asked about yet, in the language the stories are told in.
- **Verified quotes in any language:** Ask in English, Hinglish or Hindi. Gemini must answer with exact quotes, and the server checks every quote against the real transcript before showing it. If nothing they said backs the answer, Memoria says it hasn't been recorded yet. Answers are about the person, never in their voice.
- **Cassette Audio Recorder:** Captures genuine speech with live audio level analysis and winding reels.
- **Precision Audio Alignment (`clipFor`):** Answers in the "Ask" tab cite exact quotes and provide a one-tap button to play the 4-second audio window where the loved one spoke.
- **Strict Anti-Hallucination:** Memoria never synthesizes or deepfakes a voice. Listen strictly streams the genuine recording.
- **QR keepsake books:** Each QR code is a listen-only link to that one story, drawn in the browser. The family key is never printed, and deleting a story kills its link.
- **Zero-Knowledge Multi-Tenancy:** Families access their private space via a secret key (`#k=...`), with zero cross-tenant database visibility.

---

## Running on free tiers (sized for ~10k active families)

| Piece | Free service | Limit that matters | How Memoria stays inside it |
|---|---|---|---|
| Web app | Vercel Hobby | 100 GB bandwidth | Audio never goes through Vercel; demo video is tap-to-play on phones |
| API | Render free | ~0.1 CPU, sleeps when idle | Keep-warm Action; ~9k req/s locally per core, light JSON endpoints |
| Database | Neon free | 0.5 GB storage | Audio lives in R2, not Postgres; page-view events pruned after 45 days; heartbeat every 2 min |
| Audio | Cloudflare R2 | 10 GB, free egress | ~40,000 minutes at 32 kbps; private bucket, presigned links that expire in 15 min |
| Transcription | ElevenLabs → Groq Whisper → Gemini | Scribe credits | Scribe for Lifetime; free families use Groq (word timings) then Gemini |
| AI | Gemini API (+ Gemma via OpenRouter) | daily request caps | Flash-Lite for cheap tasks, cached suggestions/tributes, 60s back-off on 429, `FREE_AI_DAILY_CAP` for free families (Lifetime never capped) |

Free plan: 2 loved ones, 30 stories, 60 minutes of voice, 20 questions a day. Lifetime ($19 once): everyone, unlimited stories, 20 hours of voice, best transcription, keepsake book. An elder's answer from a question link is never refused.

Environment for the free stack (all optional; each falls back gracefully):

```
R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…  R2_BUCKET=memoria-audio
GROQ_API_KEY=…                 # free Whisper transcription with word timings
GEMINI_FAST_MODEL=gemini-2.5-flash-lite
FREE_AI_DAILY_CAP=1200         # model calls/day shared by all free families
```

Move existing recordings out of Postgres once R2 is set: `node scripts/move-audio-to-storage.js` (add `--dry-run` first).

## Running Locally

```bash
# 1. Clone & install dependencies
git clone https://github.com/CoderRahul01/memoria.git
cd memoria/app
npm install

# 2. Run automated test suite (15 passing tests)
npm test

# 3. Run full system diagnostics
npm run verify

# 4. Start local development server
npm run dev
# App running at http://localhost:3000
```

---

## Documentation

- **[System Architecture & Design (docs/ARCHITECTURE.md)](docs/ARCHITECTURE.md):** Complete HLD, LLD, Database ERD, cryptographic streaming specs, and API documentation.
- **[Startup Dossier (docs/STARTUP_DOSSIER.md)](docs/STARTUP_DOSSIER.md):** Executive summary, market analysis, unit economics, and 12-month roadmap for Startup Buildathon India 2026.

---

## Founding Team

* **Rahul Pandey** — Co-Founder & Lead AI / Systems Architect ([LinkedIn](https://www.linkedin.com/in/rahulpandey187) · [GitHub](https://github.com/CoderRahul01))
* **Twinkal Sahu** — Co-Founder & Growth / Product Lead ([LinkedIn](https://www.linkedin.com/in/twinkal-sahu-701b1a2a4/))

---

## License

[AGPL-3.0](LICENSE). Built for families everywhere.
