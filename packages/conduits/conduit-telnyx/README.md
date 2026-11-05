# @frontierjs/conduit-telnyx

Telnyx messaging over `@frontierjs/conduit`: send SMS/MMS, E.164
normalization, STOP/HELP classification, and the Ed25519 webhook signature.

**New, not extracted.** The brief names `fjs-prototypes/quo/api/src/providers/
telnyx/` as the source; it is not on this machine, so this is written from the
v2 API. The error CODES the sink answers are from memory of Telnyx's catalog
and unverified against a real account (`PROJECT_STATE.md`).

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `telnyxTarget({ ref?, address? })` — bearer, JSON |
| calls | `sendMessage(send, { from, to, text, mediaUrls?, webhookUrl? })`, `getMessage(send, id)` |
| rules | `toE164(input, defaultCountry?)` refuses before sending; `keywordOf(text)` → `STOP` / `START` / `HELP` / null |
| error mapping | `translate` — table below |
| verifier | `verifyTelnyxSignature({ rawBody, headers, publicKey, now })` — Ed25519 over `"<ts>\|<raw>"`, WebCrypto |
| sink | `sink.ts` generates its own key pair; `publicKey` on the handle |
| drive | `bun run drive` — 10 rows, sink only; no fixture exists for a carrier |

## Errors

| `errors[0].code` | HTTP | conduit kind | `TelnyxFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `40300` blocked by STOP | 422 | `client_error` | `opted_out` | never |
| `40001`, `40310`, `40311` bad number | 422 | `client_error` | `invalid_destination` | no |
| other 4xx | 4xx | `client_error` | `refused` | no |
| `10009` | 401 | `auth_failed` | `auth_failed` | no |
| `10011` | 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | by the caller |
| 5xx | 5xx | `server_error` | `server_error` | no — a send is not idempotent |

## Two columns

`sent` and `delivered` are separate. The send answers `queued`; `delivered`
arrives on `message.finalized`, and the drive proves the receipt can arrive
BEFORE the send's own answer, so the app must never overwrite the later word
with the earlier one.

## Chaos the sink owns

`{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`,
`{ finalizeFirst }`; `…0000` has texted STOP, `…9999` is not a number;
`POST /_sink/inbound` makes the sink text the app.
