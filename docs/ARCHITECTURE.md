# Architecture

Voice Memo is one Cloudflare Worker that serves the web app, the API, the processing pipeline and the scheduled jobs. One deploy, one URL, no servers to run.

```
 PHONE / MAC / BROWSER
   record → local queue (IndexedDB, or files on Android and Mac) → upload when online
        │  HTTPS: session cookie in browsers, bearer token in the apps
        ▼
 CLOUDFLARE WORKER (Hono)
   /api/*     auth, recordings, search, projects, summaries, tasks, reminders
   /mcp       Claude connector, behind OAuth 2.1
   assets     the React app
   Workflow   ProcessRecording: transcribe → clean → understand → embed
   Cron       every minute: due reminders · every 5 min: restart stuck jobs · hourly: upkeep
   Bindings   D1 (data + FTS5) · R2 (audio) · Vectorize (meaning) · KV (OAuth) · Workers AI
        │  provider keys are Worker secrets
        ▼
 FREE AI PROVIDERS (router with quota tracking and fallback)
   Speech:     Groq Whisper → Workers AI Whisper → Deepgram
   Text:       Groq gpt-oss-120b → Groq Qwen3 → Groq gpt-oss-20b → Workers AI → Mistral
   Embeddings: Workers AI qwen3-embedding-0.6b, truncated to 384 dimensions
```

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vite, React, TypeScript, Tailwind v4, `vite-plugin-pwa` | installable; readable offline |
| Build | `@cloudflare/vite-plugin` | frontend and Worker in one project; D1, R2 and KV simulated locally |
| API | Hono | small and fast on Workers |
| Pipeline | Cloudflare Workflows | each step retries on its own and keeps its result |
| Database | D1 (SQLite) with FTS5 | keyword search |
| Audio | R2 | the app caps itself at 8 GB and deletes audio after 30 days |
| Vectors | Vectorize, 384-d cosine | meaning-based search |
| Auth | Email and password (PBKDF2-SHA256, 30k iterations, server-side pepper) | single user; the setup code creates the account and resets the password |
| Validation | zod | every AI JSON reply is checked, with one repair retry |

The Workers Free plan allows about 10 ms of CPU per request. Waiting on the network doesn't count, so AI calls are fine; the Worker itself avoids heavy work per request.

## Pipeline

| Step | Work | Shown as |
|---|---|---|
| upload | audio to R2, row in D1, Workflow starts | Uploading → Queued |
| transcribe | router picks a speech provider; segments and timestamps saved | Transcribing |
| clean | an LLM removes fillers into a separate version; the raw transcript is never overwritten | Analyzing |
| understand | strict JSON: title, summary, category, thoughts, tasks, decisions, questions, reminders, vocabulary | Analyzing |
| embed | embeddings into Vectorize; FTS5 index updated | Organizing |
| finish | counters and status | Completed |

Each step retries up to five times with exponential backoff. A five-minute sweeper restarts anything stuck. Long recordings are split into 30-minute parts on the device, and long transcripts are processed in chunks to stay under the provider's per-minute token cap.

Typed notes (from the app or from Claude) skip transcription and cleaning: the text is kept exactly as written and goes straight to `understand`.

### Silence and hallucinations

Devices measure the loudest moment of a recording. Below 0.02 the audio is treated as silence and never sent to a speech provider, because Whisper invents text ("Thank you.") over quiet audio. A second check drops transcripts from quiet recordings that are only stock phrases or a few stray words.

## Providers and the router

- **Quota tracking:** `provider_usage` counts requests, tokens and audio-seconds per day in D1. A provider is skipped near its limit.
- **Fallback:** a 429, 5xx or timeout puts a provider on cooldown and moves to the next.
- **Traceability:** every output records the provider, model and prompt version.
- **Privacy first:** the defaults are providers that state they don't train on API data.

## Search and memory

Keyword search (FTS5) and meaning-based search (Vectorize) run together and are merged with reciprocal-rank fusion. The FTS tokenizer keeps Devanagari marks, so Hindi and Hinglish search works.

Vector budget: the free tier stores 5M dimensions, which is about 13,000 thoughts at 384-d. Embedding pauses at 90% and Settings shows it.

## Projects, summaries and reminders

- **Projects.** Each thought is filed to a project. Misheard names are matched to known projects by edit distance and kept as aliases, so "Lumena" lands in "Lumina". Each project has a brief that is refreshed hourly when there are new notes.
- **Summaries.** Any date range, built from SQL statistics plus an LLM pass, cached until new memos land in that range.
- **Reminders.** Extracted from "remind me…" in a memo, or created in the app or by Claude. AI-suggested reminders wait for confirmation. The Android and Mac apps sync the list and fire local notifications, so they work offline; a per-minute cron marks them sent and can push through Firebase when configured.

## The Claude connector (MCP)

`/mcp` is a remote MCP server behind OAuth 2.1 (`@cloudflare/workers-oauth-provider`, grants in KV). Signing in uses the same password and lockout rules as the app. Each tool calls the app's own API routes as the owner, so Claude sees exactly what the app shows. Connected clients are listed and revocable in Settings.

## Data model

Every table carries `user_id`. The main ones:

- `users`, `sessions`, `login_attempts`, `capture_tokens`
- `recordings`, `transcripts` (raw / cleaned / edited), `analyses`
- `thoughts` (+ `thoughts_fts`), `topics`, `entities` and their join tables
- `projects`, `tasks`, `decisions`, `questions`, `vocabulary`
- `reminders`, `push_devices`, `range_summaries`
- `provider_usage`, `provider_state`

Some tables from the original schema are reserved for features that aren't built yet (ideas, links, chat threads, digests).

## Security

- Sessions and device tokens are stored hashed; cookies are HttpOnly, Secure and SameSite=Lax.
- Sign-in locks out after 5 wrong attempts from an IP, and 30 across the account.
- Audio lives in a private bucket and is served through short-lived signed links.
- All keys are Worker secrets, set from your own terminal.
- The OAuth consent form is signed and expires, and only same-origin posts are accepted.

## Known limits

- Free tiers change; the router and multiple providers limit the damage.
- Audio goes to third-party speech providers (the defaults don't train on it).
- Busy periods can stretch processing to a few minutes.
- The vector index needs compaction after roughly 13,000 thoughts.
- Reminders created elsewhere reach a sleeping phone at its next sync unless Firebase push is configured.
