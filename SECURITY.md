# Security

This is a single-user personal app. Each deployment runs in its own Cloudflare account, with its own database, audio bucket and keys.

## Reporting a problem

Please open a [security advisory](https://github.com/hussaintrawadi/voice-memo/security/advisories/new) rather than a public issue, and allow some time for a fix before sharing details.

## What to keep private in your own deployment

- `SETUP_CODE`, `APP_SECRET` and every provider API key belong in Worker secrets (`wrangler secret put`), never in the repo.
- `.dev.vars`, `.voice-memo-url`, `android/keystore.properties` and the Android signing keystore are git-ignored on purpose. Keep them that way.
- Your deployed URL is worth keeping to yourself: sign-in locks for an hour after 30 wrong passwords across the account, so a stranger who knows the URL could lock you out.
