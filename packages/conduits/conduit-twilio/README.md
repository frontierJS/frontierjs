# @frontierjs/conduit-twilio

Twilio Programmable Messaging over `@frontierjs/conduit`. New. The second
carrier after Telnyx, built to show which SMS rules are shared: `toE164` and
`keywordOf` are copied from `conduit-telnyx` verbatim and are the `sms` helper
to promote (CONTRACT C12).

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `twilioTarget({ ref?, address? })` — `signed`, signer `basic`, `encoding: 'form'`; resolver string `AccountSid:AuthToken` |
| signer | none of its own — conduit's built-in `basic` |
| calls | `sendMessage(send, { accountSid, from \| messagingServiceSid, to, body, mediaUrls?, statusCallback? })`, `getMessage` |
| rules | `toE164`, `keywordOf`; a Body over 1600 chars refused before sending |
| error mapping | `translate` — table below |
| verifier | `verifyTwilioSignature({ url, rawBody, header, authToken })` — HMAC-SHA1 over the PUBLIC url + sorted form fields; no timestamp |
| sink | `sink.ts`; `POST /_sink/inbound` texts the app |
| drive | `bun run drive` — 12 rows, sink only |

## Errors

| `code` | HTTP | conduit kind | `TwilioFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `20003` | 401 | `auth_failed` | `auth_failed` | no |
| `21610` unsubscribed | 400 | `client_error` | `opted_out` | never |
| `21211`, `21614`, `21217`, `21408` | 400 | `client_error` | `invalid_destination` | no |
| `30034`, `21608` 10DLC / trial | 400 | `client_error` | `unregistered` | no |
| `20429` | 429 | `rate_limited` | `rate_limited` | by the caller |
| 5xx | 5xx | `server_error` | `server_error` | no — a send is not idempotent |

## Two things an operator must know

**The verifier takes the public URL.** Twilio signs the URL it was given;
behind a proxy the request's own URL is a different string and every event
fails. **There is no timestamp in the scheme**: replay is the app's
`MessageSid` dedupe.
