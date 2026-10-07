# Contributing to Memoria

Thanks for wanting to help families keep their stories.

## Ground rules

- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
- **All changes go through a pull request.** `main` is protected: it needs a passing review from the maintainer, and force-pushes and deletions are blocked.
- **Never commit secrets.** Use `.env` (it's git-ignored); `.env.example` lists every setting.
- **Keep it honest.** Memoria only answers from what was recorded, and "Listen" only ever plays the real recording. Changes that make things up about someone, or synthesize a person's voice, won't be merged.
- **Plain words in the product.** No model names or jargon in the UI.

## Running it locally

```bash
cp .env.example .env    # fill in DATABASE_URL at least
npm install
npm run dev             # http://localhost:3000
```

Every partner key is optional. Without them, Memoria falls back to the browser's transcript and simple rules.

## Pull requests

- One topic per PR, with a short description of what changed and how you tested it.
- Screenshots for anything visual.
- By contributing, you agree your contribution is licensed under the project's license (AGPL-3.0).
