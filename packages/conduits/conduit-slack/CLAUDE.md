# conduit-slack — package map

Two targets from one bundle, `slackTargets() → { api, webhook }`: the bot token
(`api`, bearer, JSON) and the incoming webhook (`webhook`, `address_from:
'request'`, no auth). `bindSlack(conduit, targets)` returns one `Send` per role
and `postMessage` / `postWebhook` each take that bundle and pick their own.
`src/index.ts` (targets + calls) · `src/blocks.ts` (Block Kit, the local
refusals) · `src/errors.ts` (`okEnvelope` and the one reader of `error.raw`) ·
`src/verify.ts` (pure; `retryOf`) · `sink.ts` · `test/slack.drive.ts`.

## What bites

- **Slack says failed inside a 200.** Every Web API call carries `okEnvelope`;
  a call without it hands `{ ok: false }` back as success, and the drive's
  `withoutValidate` row shows it.
- **A post is never keyed, never replayable.** Slack collapses nothing. A 429's
  `Retry-After` goes back to the caller; conduit replays nothing.
- **`destinations` on the webhook target is the drive's, not an app's.** The
  sink is on loopback; production registers the target bare and conduit refuses
  a private URL before anything leaves.
- **Reset keeps the messages**, as Slack would; a row counts what its own post added.
- **A `bunx` in this package runs `bun install`**, which writes a nested
  `node_modules/@frontierjs/conduit` into EVERY package pointing at the
  published copy, shadowing the live symlink — 16 rows fail. Remove the nested
  dirs and run `../../link.sh`.

## Proving a change

`bun run drive`. Green means 26 rows; there is no fixture.
