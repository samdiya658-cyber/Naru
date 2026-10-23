# Naru (chat app)

Own-brand chat app: sign in, chat with streaming replies, history, search, rename/delete, Markdown + code + math, and a batch procedure for long prompts and long answers. Runs on your own computer with a local Postgres and any OpenAI-compatible model server (llama.cpp on CPU, or the built-in `mock` demo model).

## What was merged
- **From Strata (MIT, see `third_party/Strata-MIT-LICENSE.txt`)**: the safe Markdown renderer (`src/components/Markdown.tsx`), syntax highlighting (`src/lib/syntax.ts`, `SyntaxCode.tsx`), and math rendering (`src/lib/math.ts`, `MathView.tsx`). They render without raw HTML, so model output cannot inject scripts. Small shims (`src/lib/i18n.ts`, `src/components/ui.tsx`) replace Strata's translation and button helpers. Everything else here is new.
- **Naru's own**: server (`server/`): accounts and sessions, chat streaming over SSE, Postgres storage, per-user access checks, rate/daily limits, long-prompt and long-answer batching (`server/longtext.cjs`), job records for resume, providers (mock, OpenAI-compatible). UI (`src/`): the chat screens.
- **Not used from Strata**: its inference engine and model catalog (they serve one specific large model and need more memory than an 8 GB GPU machine offers) and its desktop-app and engine-management screens.

## Run it
1. Database: `cd server && docker compose up -d` (Postgres on 127.0.0.1:5432; loads `schema.sql`). Change the password in the compose file and in `DATABASE_URL`.
2. `npm install && npm run build`
3. Demo model: `DATABASE_URL=postgres://naru:PASSWORD@127.0.0.1:5432/naru npm start` then open http://127.0.0.1:3000
4. Real model (llama.cpp): start `llama-server -m naru-q4_k_m.gguf -c 4096 --port 8080`, then run with `NARU_PROVIDER=openai NARU_BASE_URL=http://127.0.0.1:8080/v1 NARU_MODEL=naru`.
5. Live on the internet: put a Cloudflare Tunnel in front of port 3000 and set `NARU_SECURE=1` (cookies get the Secure flag). The server listens on 127.0.0.1 only.

## Tests
- `npm test`: 7 server tests against a throwaway Postgres (auth, isolation between users, chat save/reload, long prompt, long answer + resume, limits, stop).
- `python3 e2e/smoke.py http://127.0.0.1:3111`: a browser run through sign up, chat, long answer, history after reload, search, sign out (needs the server running with the demo model).

## Not done yet
Edit/regenerate with branches (the schema supports them), attachments, model picker, preferences, share links, thumbs, password reset, email verification, backups (do `pg_dump` daily). Real-model quality and CPU speed are untested here.
