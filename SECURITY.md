# Security

Memoria holds families' private stories and recordings, so security reports get priority.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

You'll get a reply within 72 hours. Once a fix ships, we're happy to credit you.

## How Memoria protects families

- Each family space is opened by a random secret key; the server stores only its SHA-256 hash.
- Every database query is scoped to the family that made the request.
- Recordings are stored privately and played only through signed links that expire after 6 hours.
- Payments are confirmed only by Dodo's signed webhook (Standard Webhooks; stale or forged notices are rejected).
- The analytics app (Pulse) reads read-only views through a login that can't see story text, keys or emails.
- Only Memoria's own sites can call the API from a browser; requests are rate limited per IP.

## In scope

The live app (memoria-family.vercel.app), its API, and this repository.
Out of scope: denial-of-service by volume, and findings that need a family's own private link.
