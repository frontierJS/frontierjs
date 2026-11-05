# @frontierjs/conduit-postmark

Postmark over `@frontierjs/conduit`: send, batch, an `IMail` adapter, and the
INBOUND webhook. New. **Postmark signs nothing**: the inbound verifier is a
constant-time compare of the Basic credential the app put in the webhook URL,
plus an optional allow-list of Postmark's sending addresses. It authenticates
the URL, not the request — the README says so first because it is the fact an
operator has to know.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `postmarkTarget({ ref?, address? })` — `api_key` under `X-Postmark-Server-Token`, JSON |
| calls | `sendEmail`, `sendBatch` (per-message status on a 200; max 500) |
| adapter | `createPostmarkMailer(send, { from, replyTo?, stream? })` — junction's `IMail` by structure |
| payload | `toPostmarkPayload` — one `Tag`, the rest in `Metadata`; `ContentID` as `cid:<id>` |
| verifier | `verifyPostmarkWebhook({ rawBody, authorization, credential, ip?, allowIps? })`, `suppressionFor(bounce)` |
| dialect | `postmarkMailDialect` — what `app.conduit.receive({ provider: 'postmark', path, dialect, credential, apply })` takes (`FJS-D899`); `toReceivedMail(inbound)` is its parse, to junction's `ReceivedMail` by structure (`FJS-D1091`); the dedupe key is Postmark's `MessageID`, its id for the delivery |
| types | `PostmarkInbound` (the parsed message, `OriginalRecipient` the envelope address a reply tag rides), `PostmarkBounce`, `ReceivedMail`, `PostmarkMailEvent` |
| sink | `sink.ts`; `POST /_sink/inbound` delivers a parsed message with the URL's credential |
| drive | `bun run drive` — 11 rows, sink only |

## Errors

| `ErrorCode` | HTTP | conduit kind | `PostmarkFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `10` bad token | 401 | `auth_failed` | `auth_failed` | no |
| `300` malformed address / no body | 422 | `client_error` | `refused` | no |
| `406` inactive recipient (bounced before) | 422 | `client_error` | `suppressed` | no |
| 429 | 429 | `rate_limited` | `rate_limited` | by the caller |
| 5xx | 5xx | `server_error` | `server_error` | no — a send is not idempotent |

`SendResult.id` is Postmark's `MessageID`, a GUID — the second mailer's
answer to `FJS-D684`, beside Resend's `id`.
