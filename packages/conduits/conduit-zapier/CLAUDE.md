# conduit-zapier — package map

`src/index.ts` the target, binder, `postHook`, `unsubscribe`, `subscriptionFrom` · `src/errors.ts` the one reader of `raw`, `hookEnvelope` · `src/types.ts` · `sink.ts` · `test/zapier.drive.ts`.

## What bites

- **One target, `address_from: 'request'`, `auth: none`, host NOT pinned.** The form field the two legacy apps ship takes an IFTTT or Make URL beside a Zapier one; a 404 from one of those reads as `off` too. `subscriptionFrom` is where the host IS pinned (`hooks.zapier.com`), because a forged `target_url` is the SSRF primitive the post would then carry out.
- **`destinations` stays off in production.** The drive passes `{ allowHttp: true, allowPrivate: true }` for its loopback sink and its negative control proves the production target refuses that URL before the send.
- **A post is unkeyed and never replayed**; a lost one is `indeterminate` and nothing resolves it. A 5xx on a post comes back `retryable: false` and `indeterminate: true` — conduit's word for "safe to send again" is false not because Zapier refused it but because conduit cannot know the Zap did not run.
- **`unsubscribe` is `replayable: true`**: a replayed lost DELETE finds the hook gone and answers `already: true`, which is the state asked for.
- **A 404 arrives hours after the Zap is switched off.** Zapier says so; the sink cannot model the lag and does not try.
- **Conduit drops the trailing slash** on the address; the sink accepts both spellings. Whether Zapier does is unverified.
- **The receipt fields are observed, not documented.** `hookEnvelope` accepts an empty body (silent mode) and refuses a `status` that is not `success`.

## Proving a change

`bun run drive`: 17 rows against the sink. No fixture — Zapier is hosted. Never `bun install` or `bunx tsc` here — `../../AGENT_BRIEF.md`.
