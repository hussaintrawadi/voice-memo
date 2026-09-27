# Contributing to Voice Memo

Thanks for helping. Small, focused pull requests are the easiest to review.

## Getting started

1. Follow **Deploy your own** in the README far enough to create the `-dev` resources, or at
   least copy `wrangler.example.jsonc` to `wrangler.jsonc` and `.dev.vars.example` to `.dev.vars`.
2. Run it:

   ```bash
   npm install
   npm run db:migrate:local
   npm run dev
   ```

3. Before you open a pull request:

   ```bash
   npm test
   npm run typecheck
   ```

The unit tests run in Node with the Workers modules stubbed, so they need no Cloudflare account.

## Ground rules

- **Free tiers first.** Voice Memo is meant to cost nothing to run. A change that needs a paid
  plan, or pushes a free quota much harder, needs a strong reason and a way to turn it off.
- **Your data stays yours.** Only use AI providers that say they do not train on API data, and
  never send memos anywhere the person did not configure.
- **Migrations only move forward.** Add a new numbered file in `migrations/`. Never edit one that
  has shipped.
- **Nothing is changed silently.** Anything the AI changes in open tasks, decisions, reminders or
  questions goes through `context_changes`, so it shows up on Home and can be undone.
- **Keep the three apps in step.** A feature in the web app that touches recording, uploads or
  reminders usually needs the Android and Mac pieces too, or a note on why not.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened. For transcription or
analysis problems, say which provider handled the memo (it is shown on the memo page) and leave
out anything personal from the transcript.

For security problems, see [SECURITY.md](SECURITY.md).
