# @frontierjs/conduit-telnyx

Telnyx over `@frontierjs/conduit`: texts, Call Control, WebRTC credentials, the
media stream and the Ed25519 webhook signature.

Extracted from the quo and serpgrid providers, which ran against the live
carrier. Every call takes the bound `send` first; an app's environment, its
default country, its connection ids and its `client_state` type stay in the app.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `telnyxTarget({ ref?, address?, id?, perCaller?, resilience? })` — bearer, JSON. `perCaller` asks the resolver `getFor(ref, who)`; `resilience` has no default |
| texts | `sendMessage(send, { from, to, text, mediaUrls?, webhookUrl?, messagingProfileId?, defaultCountry? })`, `getMessage(send, id)` |
| numbers | `toE164(input, defaultCountry?)` refuses before sending; `isE164(s)` reads a number as the carrier spells it back (7–15 digits) |
| keywords | `keywordOf(text)` → `STOP` / `START` / `HELP` / null |
| call control | `callAction(send, { callControlId, action, commandId, clientState?, params? })`, `dial(send, { connectionId, from, to, commandId, clientState?, linkTo?, timeoutSecs?, defaultCountry? })`, `recordingLink(send, id)` — `command_id` is a body field and both are `replayable` |
| `client_state` | `encodeClientState`, `decodeClientState` — JSON over base64; `callAction<S>` and `dial<S>` take the app's state type |
| events | `parseEvent(body)` → flat `TelnyxEventRecord` `{ id, type, occurredAt, payload }`; `TelnyxEvent` is the nested messaging webhook |
| credentials | `createCredential(send, { connectionId, name })`, `deleteCredential(send, id)`, `sipUri(user)`, `credentialToken({ address, key, credentialId })` |
| media stream | `parseFrame`, `mediaFrame`, `markFrame`, `clearFrame`, μ-law and `toneAudio` / `silence` / `level` (`src/stream.ts`) |
| error mapping | `translate` — table below |
| verifier | `verifyTelnyxSignature({ rawBody, headers, publicKey, now })` — Ed25519 over `"<ts>\|<raw>"`, WebCrypto; refuses a timestamp that is not whole seconds and a signature that is not 64 bytes |
| sink | `@frontierjs/conduit-telnyx/sink` — below |
| drive | `bun run drive` — 28 rows, sink only; no fixture exists for a carrier |

## Two things that are not obvious

**A call command's idempotency is in the body.** Telnyx drops a repeated
`command_id` within 60s and answers the first reply again; conduit's
`idempotency_key` is a header Telnyx ignores. So `callAction` and `dial` are
`replayable: true` with the id in the body, and the target they share with texts
needs a `resilience` the app states. A text has no key: a resend is a second
text, and conduit does not replay one once it may have left.

**`credentialToken` goes around conduit.** Telnyx answers the token as a bare JWT
with no content-type, and conduit refuses an untyped body that is not JSON
(`invalid_response`, the drive pins it). The app passes the address and the key
it resolved for this account.

## Errors

| `errors[0].code` | HTTP | conduit kind | `TelnyxFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `40300` blocked by STOP | 422 | `client_error` | `opted_out` | never |
| `40001`, `40310`, `40311`, `10039` bad number | 422 | `client_error` | `invalid_destination` | no |
| other 4xx | 4xx | `client_error` | `refused` | no |
| `10009` | 401 | `auth_failed` | `auth_failed` | no |
| `10011` | 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | by the caller |
| 5xx | 5xx | `server_error` | `server_error` | no — a send is not idempotent |

`40300` and `10039` were seen against the live carrier; the rest are from
Telnyx's catalog. `OPTED_OUT_CODES` and `INVALID_DESTINATION_CODES` are the one
place to correct them.

## Two columns

`sent` and `delivered` are separate. The send answers `queued`; `delivered`
arrives on `message.finalized`, and the drive proves the receipt can arrive
BEFORE the send's own answer, so the app must never overwrite the later word
with the earlier one.

## The sink

`startTelnyxSink({ port?, key?, hookUrl?, seed?, … })` is synchronous and
returns `{ url, port, publicKey, log, sent, idle, stop, … }`.

- **Key and hook.** `key` is the bearer, or a list of them (one per account for a
  per-caller target). `hookUrl` is a string, or a getter for an app that binds
  after the sink. `publicKey` is what the webhooks verify under; `seed` fixes it
  across restarts, otherwise it is fresh.
- **Connections.** `callControlConnection` and `credentialConnection` name what an
  inbound call and a browser's parked call arrive on.
- **Numbers.** `…0000` has texted STOP, `…9999` is not a number; the exact
  `MAGIC_FAIL` (undeliverable), `MAGIC_BLOCKED` (STOP) and `MAGIC_UNOWNED` (a
  `from` the account does not hold) win over the suffixes.
- **Options.** `duplicate`, `shuffle`, `receiptsFirst`, `loseResponse`,
  `loseDialResponse`, `lateInitiated`, `digits`, `callerScript`, `streamMode`,
  `burstFrames`.
- **Armed over `POST /_sink/arm`**, for the next request: `{ lost }`,
  `{ rateLimit: { retryAfter } }`, `{ failNext }`, `{ deliverTwice }`,
  `{ finalizeFirst }`. `POST /_sink/inbound` makes it text the app;
  `GET /_sink/seen` is what it saw; `POST /_sink/reset` clears both.
- **Calls.** It plays Call Control, device legs on `sip:` identities
  (`ringing`, `answer`, `decline`, `hangup`, `deviceCall`) and the media stream:
  `streaming_start` makes it dial the app's `stream_url` as a WebSocket and speak
  Telnyx's frames from `callerScript`.
