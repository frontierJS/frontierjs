# conduit-anthropic — package map

The Messages API's dialect: `x-api-key`, a required version header, a billed
POST that must not be replayed, SSE read through `conduit.stream()`.
`src/index.ts` (target, calls, tool loop, the stream) · `src/errors.ts`
(the one reader of `error.raw` and `meta.status`) · `src/types.ts` · `sink.ts` ·
`test/anthropic.drive.ts`.

## What bites

- **`createMessage` carries neither a key nor `replayable`.** A 429 therefore
  comes back after ONE attempt with `retryAfterMs` set; conduit never sleeps
  on it. Adding `replayable: true` makes the drive's rate-limit row wait seven
  seconds and bill twice.
- **`translate()` reopens `retryable` on a 529 and nowhere else.** Conduit's
  `declineReplay` marks every unkeyed 5xx indeterminate; the vendor says a 529
  was refused before running. A 500 keeps conduit's verdict.
- **There is no `fetch` in the package.** `streamMessage` takes `bindStream(conduit)`,
  and a refusal before the first event arrives as a `ConduitStreamError` whose
  `meta.status` goes to `translate()`, the same status `createMessage` hands it
  (`FJS-D934`). `stream.crossesTheSeam` counts conduit's own `streams.opened`.
- **A stream that ends without `message_stop` is `stream_error`.** The sink's
  `controller.error()` reaches conduit as a throw and comes back as
  `stream_error`, not `indeterminate`, because the 2xx says the request ran.
  The check after the loop is for a server that closes cleanly mid-answer,
  which conduit cannot tell from an answer that finished.
- **The sink prints `error: upstream died` on the death row.** That is Bun
  reporting the errored `ReadableStream`, not a drive failure; the row is green
  beneath it.
- **The sink's prompt cache survives `/_sink/reset`.** The cache row is two
  calls, and a reset between sections must not forget the first.
- **The drive overrides `resilience.timeout_ms` on the descriptor**, not per
  call: a shorter `req.timeout_ms` is the caller's patience and does not reach
  the lost-response row the same way.

## Proving a change

`bun run drive`. Green means 22 rows; there is no fixture.
