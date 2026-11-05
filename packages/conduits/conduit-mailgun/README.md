# @frontierjs/conduit-mailgun

Mailgun over `@frontierjs/conduit`: send, an `IMail` adapter, and the INBOUND
route that forwards raw MIME. New. **This is the connector that brings the MIME
parser** (`FJS-D784`, `FJS-D1091`): a Mailgun route whose forward URL ends in
`mime` posts the whole RFC 5322 message and parses nothing, and `fromMime`
turns it into junction's `ReceivedMail` — the parser a second raw-MIME vendor
(SES) imports rather than writes.

**The webhook signature covers `timestamp + token` and no byte of the body.**
Inside the window a captured signature verifies over any body at all, so the
verifier keeps the window tight (5 minutes) and spends `token` as a nonce
through conduit's `seenNonce`. That pair is what stands behind the body; the
README says so first because it is the fact an operator has to know.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `mailgunTarget({ ref?, address?, id? })` — Basic under the built-in `basic` signer; **the credential is the string `api:<key>`**; `address: MAILGUN_EU_ADDRESS` for an EU account |
| calls | `sendEmail(send, domain, form)`, `events(send, domain, query)` — the read that resolves a lost send (C6), filtered on a `v:` variable the caller set |
| adapter | `createMailgunMailer(send, domain, { from, replyTo? })` — junction's `IMail` by structure |
| payload | `toMailgunForm` — one `o:tag` (conduit's form encoder indexes an array, Mailgun reads repeated keys), every tag also a `v:` variable; `h:` headers; **attachments refused before the send**, since a target has one body encoding and a file needs multipart |
| verifier | `verifyMailgunSignature({ fields, key, now, windowSeconds?, seenNonce? })` — pure, freshness before crypto, constant-time |
| dialect | `mailgunMailDialect` — what `app.conduit.receive({ provider: 'mailgun', path, dialect, credential, apply })` takes (`FJS-D899`); the credential is the webhook signing key; `parse` is async (the MIME parser is); the dedupe key is the recipient AND the mail's Message-ID, or `sha256:` of the bytes when it has none, because Mailgun names no delivery and a retry is re-signed with a new token |
| parser | `fromMime(raw, { recipient, sender? })` — postal-mime underneath; `Message-ID`, `In-Reply-To` and `References` pinned to Postmark's spelling, every other header in the sender's; inline parts are attachments with `cid` |
| types | `MailgunForward` (the form a `mime` route posts), `ReceivedMail`, `MailgunMailEvent`, `MailgunEvent` |
| sink | `sink.ts`; `POST /_sink/inbound` writes a raw message (encoded words, quoted-printable, base64 parts) and forwards it signed; `deliverTwice` re-signs with a new token |
| drive | `bun run drive` — 13 rows, sink only |

Not built: event webhooks (bounces, complaints — a different, JSON-signed
delivery), the parsed-message forward (a URL not ending in `mime`), batch
sending with recipient variables, attachments on a send.

## Errors

| HTTP | body | conduit kind | `MailgunFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| 400 | `{ message }` in Mailgun's wording | `client_error` | `refused` | no |
| 401 | the word `Forbidden` | `auth_failed` | `auth_failed` | no |
| 404 | `Domain not found: …` | `client_error` | `gone` | no |
| 429 | | `rate_limited` | `rate_limited` | by the caller |
| 5xx | | `server_error` | `server_error` | no — a send is not idempotent |

`SendResult.id` is the Message-ID Mailgun stamped, angle brackets included — a
third shape for `FJS-D684` beside Resend's `id` and Postmark's GUID.
