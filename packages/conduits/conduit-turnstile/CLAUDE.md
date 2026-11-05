# conduit-turnstile — package map

`src/index.ts` is the whole connector. `sink.ts` · `test/turnstile.drive.ts`.

## What bites

- **The signer checks the content-type, not the body's type**: a JSON body is a string too.
- **A signer throw is `auth_failed`, nothing sent** (FJS-2726) — the misconfigured-target row asserts it.
- **`expectedHostname`/`expectedAction` are the app's declaration**; Cloudflare verifies a token for ANY site under the account.

## Proving a change

`bun run drive`: 12 rows.
