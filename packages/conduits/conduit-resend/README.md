# @frontierjs/conduit-resend

Resend over `@frontierjs/conduit`: send, batch, an `IMail` adapter, and the
Svix webhook signature. Extracted from
`frontierjs/packages/junction/src/mail/index.ts` § Resend adapter at commit
`6ad199f2` — the one vendor dialog that lived INSIDE a battery (`FJS-D153`'s
inversion). Junction keeps its copy.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `resendTarget({ ref?, address? })` — bearer, JSON |
| calls | `sendEmail(send, email)`, `sendBatch(send, emails)` |
| adapter | `createResendMailer(send, { from, replyTo? })` — junction's `IMail` by structure; a failure throws with `kind` and `retryable` on the error |
| payload types | `MailMessage` (junction's shape), `ResendEmail`, `ResendEvent` |
| error mapping | `translate(ConduitError) → ResendFailure` |
| verifier | `verifyResendSignature({ rawBody, headers, secret, now })`, `suppressionFor(event)` |
| sink | `sink.ts`; an address under `@bounce.example` bounces |
| drive | `bun run drive` — 12 rows, sink only |

## Errors

| vendor `name` | HTTP | conduit kind | `ResendFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `validation_error`, `invalid_parameter`, `not_found` | 400/404/422 | `client_error` | `refused` | no |
| bad key | 401 | `auth_failed` | `auth_failed` | no |
| `rate_limit_exceeded` | 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | yes, **by the caller** |
| `daily_quota_exceeded` | 429 | `rate_limited` | `quota` | no |
| 5xx | 5xx | `server_error` | `server_error` | **no** — see below |

## The rule this connector is about

**A send is not idempotent and Resend honors no idempotency header.** Every
send is unkeyed and unreplayable, so conduit never retries it: a 429, a 500
and a lost response all come back to the caller, who knows whether a second
email is acceptable. The drive's `lostResponse.notReplayed` row counts the
emails the sink actually sent after a timeout: one.

## Chaos the sink owns

`{ lost }`, `{ rateLimit: { retryAfter } }`, `{ quota }`, `{ failNext }`,
`{ deliverTwice }`, `{ rotatedSecret }` (two `v1,` signatures on one header).
