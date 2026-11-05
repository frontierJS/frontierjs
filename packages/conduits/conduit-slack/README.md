# @frontierjs/conduit-slack

Slack over `@frontierjs/conduit`: `chat.postMessage` with a bot token, incoming
webhooks by URL, and the Events API signature. Two targets in one bundle, because Slack has
two ways in that share nothing.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `slackTargets({ ref?, address?, id?, webhookDestinations? }) → { api, webhook }` — `api`: bearer `SLACK_BOT_TOKEN`, JSON, `https://slack.com`; `webhook`: `address_from: 'request'`, `auth: none`, the URL is the credential (`FJS-1667`) |
| calls | `postMessage(send, { channel, text?, blocks?, thread_ts? })`, `postWebhook(send, url, { text?, blocks? })` — unkeyed, unreplayable |
| Block Kit | `section`, `header`, `divider`, `context`, `mrkdwn`, `plain` — limits refused before the send |
| validator | `okEnvelope` — refuses `ok: false` on every Web API call (C4) |
| error mapping | `translate(ConduitError, status) → SlackFailure` — the table below |
| verifier | `verifySlackSignature({ rawBody, headers, secret, now })` — pure; answers `url_verification` with `challenge`; `retryOf(headers)` for a redelivery |
| sink | `sink.ts`, `startSlackSink()` on `port: 0`, both dialects |
| drive | `bun run drive` — 26 rows, sink only; no fixture exists |

`slack` is `bindSlack(conduit, targets)`, one `Send` per role; `postMessage(slack, …)` goes through `slack.api` and `postWebhook(slack, …)` through `slack.webhook`, so a call cannot be handed the wrong target.

## `destinations` is off in production

A webhook URL is pasted by somebody else, so conduit grades it against private
and loopback addresses before every attempt. The drive's sink is on localhost
and passes `{ allowHttp: true, allowPrivate: true }`; an app never does. The
drive's negative control registers the target bare and shows the sink's own URL
refused with nothing on the wire.

## Errors

The Web API answers HTTP 200 whether or not it worked; `okEnvelope` turns an
`ok: false` into `invalid_response` and `translate` reads Slack's word out of
`raw`. The webhook answers plain text graded by status.

| Slack says | HTTP | conduit kind | `SlackFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `channel_not_found`, `not_in_channel`, `invalid_blocks`, `no_text` | 200 | `invalid_response` | `refused` | no |
| `invalid_auth`, `token_revoked`, `account_inactive` | 200 | `invalid_response` | `auth_failed` | no |
| `msg_too_long` | 200 / 400 | `invalid_response` / `client_error` | `too_long` | no |
| `ratelimited` + `Retry-After` | 429 | `rate_limited` | `rate_limited`, `retryAfterMs` | yes — handed to the caller, never replayed |
| `fatal_error`, `internal_error` | 200 | `invalid_response` | `server_error` | yes — the caller's retry is a new post |
| webhook `no_service` | 404 | `client_error` | `gone` — delete the row | no |
| webhook (any) | 410 | `client_error` | `gone` | no |
| webhook `invalid_payload` | 400 | `client_error` | `refused` | no |

A post is never keyed and never replayable: Slack collapses nothing, so a lost
response is `indeterminate` and the message may be in the channel. The read
that resolves it is `conversations.history`, out of scope here; the webhook
has no read at all (CONTRACT § Amendments, C6).

## Inbound

`X-Slack-Signature: v0=<hex HMAC-SHA256>` over `v0:<X-Slack-Request-Timestamp>:<raw body>`,
300 s tolerance, constant-time. The verifier takes a `Headers` or a lowercase
record. A redelivery arrives under `X-Slack-Retry-Num`; the app answers 200 and
dedupes on `event_id` — the table is the app's.

## Chaos the sink owns

`/_sink/arm` with `{ lost }`, `{ rateLimit: { retryAfter } }`, `{ failNext }`
(one 200 `fatal_error`), `{ deliverTwice }`. Channel `#missing` is
`channel_not_found`, `#locked` is `not_in_channel`, text over 4000 is
`msg_too_long`. `/services/T000/B000/live` answers `ok`, `/…/deleted` answers
404 `no_service`. `POST /_sink/event { type, event_id?, event, challenge? }`
signs and delivers to `hookUrl`.
