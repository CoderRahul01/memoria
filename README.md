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

- **Cassette Audio Recorder:** Captures genuine speech with live audio level analysis and winding reels.
- **Precision Audio Alignment (`clipFor`):** Answers in the "Ask" tab cite exact quotes and provide a one-tap button to play the 4-second audio window where the loved one spoke.
- **Strict Anti-Hallucination:** Memoria never synthesizes or deepfakes a voice. Listen strictly streams the genuine recording.
- **Interactive QR Keepsake Books:** Print-ready heirloom books with embedded audio QR codes—point any phone camera at the physical paper to hear their voice.
- **Zero-Knowledge Multi-Tenancy:** Families access their private space via a secret key (`#k=...`), with zero cross-tenant database visibility.

---

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
