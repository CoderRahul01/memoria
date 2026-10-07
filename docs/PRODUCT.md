# Memoria — product scope

## What we're making

**Memoria keeps the stories only one person knows, in their own words, so the whole family can ask about them later.**

Someone sits with a grandparent (or a parent, or themselves), presses record, and lets them talk. Memoria turns the talk into text, gives it a title and a year, and files it in that person's album. Later, anyone in the family can ask, *"How did Nani make the dal?"*, and get an answer drawn only from what Nani said, with her exact words shown underneath.

It is not a journaling app, a genealogy tree, or a chatbot that pretends to be someone. It's a **family oral-history keeper**, and the answers are only ever as good as what was recorded. That honesty is the product.

## Who it's for: a global market, not "Grandpa"

The first version hard-coded "Grandpa". The real market is **every family with an older relative whose stories haven't been written down**, in every language. That's hundreds of millions of households. The buyer is usually an adult child or grandchild, aged 25–50, who feels the clock ticking: a diagnosis, a milestone birthday, a funeral where they realised nobody knew the recipe.

| Segment | Moment that triggers it | What they keep |
|---|---|---|
| Grandchildren (25–40) | Grandparent turns 80, or falls ill | Recipes, migration stories, childhood |
| Adult children (35–55) | Parent's retirement, or after a loss | Life lessons, family history, voice |
| People keeping their *own* stories | New parent, or a health scare | "What I want my kids to know" |
| Diaspora families | Distance from the home country | Language, festivals, places that no longer exist |

Why it travels globally: speech-to-text works in 90+ languages, there's nothing to install, and the story itself is the content. No localisation of a feed or catalogue is needed.

## How each person gets their own space

- Each household gets a **private family space**, opened by a secret link. No sign-up is needed for the first story.
- Inside it, **every loved one has their own album**: their stories, their timeline, their voice, and their own Ask.
- "My own" is a first-class choice, so anyone can record their own life for their children.
- Sharing the private link invites siblings and cousins to add and ask.

## Business model: free to start, one payment for life

| | Free | Lifetime — $19 once |
|---|---|---|
| Loved ones | 1 | Unlimited |
| Stories | 15 | Unlimited |
| Ask questions | ✓ | ✓ |
| Download everything | ✓ | ✓ |
| Hear stories in *their own* voice | — | ✓ |
| Printable keepsake book | — | ✓ |

- Checkout: a Dodo Payments static link (live) carries the family ID, and a signed `payment.succeeded` webhook unlocks the family. No subscription, by design: grief and nostalgia don't fit a monthly plan.
- Unit cost per family: a few cents of open-model inference per story or question, plus ElevenLabs voice for Lifetime families. $19 covers years of normal use.
- Abuse guard: an AI budget per family per hour (60 free / 300 Lifetime).

## What's built today (v1, launch-ready)

- Landing page, a two-question onboarding, and a private family space
- A **cassette recorder**: the reels turn while recording, the tape winds left-to-right as time passes, and a level bar shows the phone can hear them
- Live transcript in the browser, plus server transcription in 90+ languages; the raw audio is deleted
- Automatic title, year, category and tags (Gemma 4, open weights)
- **Album** with a "life so far" timeline placed by year, search and filters
- **Ask** grounded in that person's stories, with the exact quote and its source story; an honest "they haven't talked about this yet" with a one-tap "Record this story"
- **Keep forever**: an AI-written tribute, their own cloned voice (with consent), reading voices, JSON download, a printable keepsake book, and invite-the-family
- **Founder dashboard** (`/admin`): live users and what they're doing, families, daily and weekly actives, stories, questions, revenue, the journey from opening to buying, AI speed and errors per step, the latest activity feed, regions
- Data in Postgres (Neon), so it survives redeploys

## What we can do next (ranked by impact ÷ effort)

1. **Email sign-in (magic link)** as a second key alongside the private link, so a lost link never means lost stories. *Most important before paid scale.*
2. **Interview mode**: Memoria asks the next question out loud based on what they just said ("You mentioned Lahore — what was your street like?"). This turns a 2-minute recording into 20.
3. **Weekly question by WhatsApp or email** to the family ("Ask Dadu this week: …"), which drives retention and more stories.
4. **Photos on stories**: attach a scanned photo; the keepsake book becomes a real album.
5. **Printed hardcover book** fulfilled through a print-on-demand partner. A natural $39–59 upsell and gift product.
6. **Gift Lifetime**: buy it for a parent's birthday. A gift card checkout in Dodo.
7. **Family tree view**: the people mentioned across albums, linked.
8. **Languages of the interface** (Hindi, Spanish, Portuguese, Arabic first). Recording already works in any language.
9. **Shared listening links**: send one story (read in their voice) to a relative without giving full album access.
10. **Data durability**: nightly export to the family's Google Drive.

## Launch checklist

- [x] Render backend with Neon Postgres, Vercel frontend
- [x] Live Dodo product + webhook
- [x] Founder analytics
- [ ] Set the production env vars on Render (see the README)
- [ ] Post on DEV (Hacktoberfest), X and LinkedIn with a 30-second screen recording of the cassette in action
- [ ] Submit to Product Hunt one week later, once the first real families' stories exist
