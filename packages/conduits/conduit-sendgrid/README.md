# @frontierjs/conduit-sendgrid

SendGrid over `@frontierjs/conduit`: v3 mail send, an `IMail` adapter beside
resend, postmark and mailgun, the ECDSA event-webhook verifier, and the
sending-domain lifecycle that returns CNAMEs for the app's DNS writer.

**Written from two callers, not extracted.** kos's `domain/mail/sendgrid.ts`
(send, `custom_args.messageId`, the webhook verified by hand) and the maid.tech
port's `integrations/sendgrid/` (the per-tenant sending-domain lifecycle). No
real account was called; the shapes are theirs and the docs'.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `sendgridTarget({ ref?, address? })` — bearer, JSON |
| payload | `toSendgridPayload(msg, { from, replyTo? }, { messageId?, sandbox? })` — refuses a `replyTo` without an address and an address without `@` before the send |
| calls | `sendEmail(send, payload)` → `{ id }` from `X-Message-Id`; `authenticateDomain`, `validateDomain`, `getDomain`, `listDomains`, `removeDomain` |
| adapter | `createSendgridMailer(send, { from, replyTo?, sandbox? })` — junction's `IMail` by structure; `tags.messageId` rides `custom_args` |
| error mapping | `translate(error, status)` — table below |
| verifier | `verifySendgridSignature({ rawBody, headers, publicKey, now })` — ECDSA P-256 over `timestamp + raw`, DER signature and SPKI key as base64 |
| records | `dnsRecordsOf(domain)` — three `CNAME`s, every one `proxied: false` |
| sink | `sink.ts` generates its own key pair; `publicKey` on the handle; `dnsAfter` validate calls before a domain reads valid |
| drive | `bun run drive` — 14 rows, sink only |

## Errors

| HTTP | conduit kind | `SendgridFailure.kind` | retryable |
| --- | --- | --- | --- |
| 400 (`field` names the pointer) | `client_error` | `refused` | no |
| 401 | `auth_failed` | `auth_failed` | no |
| 403 unverified sender | `auth_failed` | `forbidden` — the policy's, not the key's | no |
| 404 | `client_error` | `gone` | no |
| 413 | `client_error` | `too_large` | no |
| 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | by the caller |
| 5xx | `server_error` | `server_error` | no — a send is not idempotent |

## Lost sends

SendGrid collapses nothing and answers no idempotency key. The read that says
whether a lost send landed is the Email Activity API
(`GET /v3/messages?query=unique_args['messageId']="…"`), a paid add-on on the
account; this package names it and does not build it. Until then an app treats
a `timeout` on a send as possibly delivered and lets the `processed` event
settle it.

## Sending domains

`authenticateDomain` → apply the three CNAMEs (`conduit-cloudflare`, never
proxied) → `validateDomain` with backoff until `valid` → only then promote the
from-address. That is the lifecycle maid.tech's legacy CRM ran per tenant, and
the one bug it met twice: a proxied CNAME never resolves for DKIM, so the record
shape carries `proxied: false` rather than leaving it to the writer.

## Chaos the sink owns

`{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`; a from-address
at `@unverified.test` is 403; `sandbox_mode` answers 200 with no id and still
refuses a bad sender; a second `authenticateDomain` of the same name is 400.
