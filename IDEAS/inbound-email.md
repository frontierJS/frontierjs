---
id: inbound-email
status: partial
dated: 2026-10-16
---

# Idea — inbound email: a reply lands on the record it answers

**Status: PARTIAL.** Ruled 2026-10-16 ([`FJS-D1091`](../DECISIONS.md#fjs-d1091) the
shape, [`FJS-D1092`](../DECISIONS.md#fjs-d1092) the expiry, [`FJS-D1093`](../DECISIONS.md#fjs-d1093)
the proof). Built: `ReceivedMail` and the reply-tag kit in `@frontierjs/junction/mail`
(`received.ts`, `test/mail-received.test.ts`); `@frontierjs/conduit-postmark`'s
`postmarkMailDialect`; and `@frontierjs/conduit-mailgun`'s `mailgunMailDialect`
over `fromMime` — the raw-MIME parser `FJS-D784` named, postal-mime underneath,
the one SES imports; conduit's `Dialect.parse` may be a promise for it. Both
connectors are shaped as `packages/` members and held in `../conduit-connectors/packages/` until the owner commits them (2026-10-16). Not built: the chatwoot
stressor's hand-rolled `inbound.ts`/`mailgun.ts`/`token.ts` collapsing onto
the kit. It is the email
leg that [`FJS-D177`](../DECISIONS.md#fjs-d177) excluded by name — *"Rails made
that its own noun (`ActionMailbox`) and was right to"* — and that
`ecosystem-gaps.md` § 14 recorded from the OpenMRP audit: FJS sends an order
confirmation in one line and cannot receive the reply to it. Stressor #5
(Chatwoot/Zendesk) is the app that would force it.

**It sits on top of `inbound-integrations.md` half B.** A self-hosted Bun app
gets mail through a provider's inbound webhook (Postmark, SES, Mailgun, Resend),
so the first hop is a counterparty's scheme arriving at conduit. Build that
first; this is the layer that routes what it hands over.

---

## Prior art: Void's `email/` directory

Read 2026-10-07 from `void.cloud/guide/email/receiving`. Void (VoidZero) runs on
Cloudflare Workers, and its handler is Cloudflare's Email Worker signature with
routing added on top.

- **The filename routes on the `To` local part**, case-insensitive, most
  specific first: `support+vip.ts` · `support+[ticket].ts` · `support.ts` ·
  `[user]+vip.ts` · `[user]+[tag].ts` · `[user].ts` · `_default.ts`. A captured
  segment arrives as `info.params`.
- **A handler that returns without acting accepts the message**; `setReject`,
  `forward` and `reply` are Cloudflare's own verbs.
- **It only works on their platform.** Node, Bun and Deno builds have no inbound
  mail.

## What carries over

**The captured plus-tag is the threading mechanism.** The open question in
`ecosystem-gaps.md` is how a reply finds its record without guessing from a
subject line. The answer is to send with `replyTo: reply+<token>@<domain>` and
read the token back from the address the reply arrives at. Junction's mailer
already takes a per-message `replyTo` (`junction/src/mail/smtp.ts`,
`junction/src/mail/index.ts`), so the outbound half exists.

**The token is signed, and it names the record and the person it was sent to.**
A bare id in the tag lets anyone mail `reply+42@` and post onto order 42; Void's
own example (`acme+support+abc-123@`) carries the id in plain text.
`@frontierjs/toolbelt/signature` is the kit for this.

**A handler file named for what it receives** fits the convention
notifications and jobs already follow (`OrderPaid.notification.ts`,
`<name>.job.ts`). What the file suffix is called is a noun, and coining it runs
`decision-rules`.

## What does not carry over

- **Rejecting or forwarding at SMTP time.** Those verbs belong to the receiving
  mail server. Behind a provider webhook the message has already been accepted,
  so a handler's choices are to act on it or to drop it.
- **The `From` header as an identity.** A receiver runs as the system and maps
  the payload to a Service call — `inbound-integrations.md`'s guardrail, which
  holds here unchanged. A message is attributed to a user only when the signed
  token names them; DKIM alignment is a second signal, and on its own `From` is
  a claim.

## What FJS adds that Void leaves to the handler

- **Dedupe on `Message-ID`** through `claimIdempotency`, because providers retry
  webhooks.
- **Attachments go to litestone's `FileStorage` plugin**, the one owner of
  stored bytes ([`FJS-D260`](../DECISIONS.md#fjs-d260)).
- **The mapping from a parsed message to a Service call is declared**, so the
  Service's own validation runs at the boundary, which is the argument
  `ecosystem-gaps.md` § 14 makes for webhooks.

## Open questions

1. ~~**What is the noun, and is it a file convention (Void's routing) or a declaration in conduit beside the provider it arrives from?**~~ **Answered 2026-10-16 (`FJS-D1091`): D — C's first half is already built and its second half is code, not a file. The arrival is an ordinary conduit `Receiver` (`FJS-D899`): the mail vendor's connector exports the `Dialect` (`conduit-postmark` parses a JSON body, a raw-MIME vendor's connector brings the MIME parser, `FJS-D784`), each parsing to ONE shape, `ReceivedMail` — junction's `MailMessage` read the other way, plus the envelope `recipient` the plus-tag rides on — owned by `@frontierjs/junction/mail` beside `MailMessage`, structurally copied by a connector as `MailMessage` already is. What an address does is the app's `apply`, with the framework supplying the kit the stressor hand-rolled: `replyAddress(base, id, secret)` mints `base+<token>@domain` and refuses a base too long to carry one, `splitAddress(address)` gives `{ base, tag }`, `readReplyTag(tag, { secret, now, ttlSeconds })` reads the token back, all over `toolbelt/signature`'s `mintToken`/`readToken` under one purpose. No file convention and no `Mailbox` noun: a mailbox someone else owns, read by delta and written back (ELA's M365 inbox, `FJS-2574`), is a sync engine and not this feature.**
   - **A** — a file convention: `api/src/mailboxes/<address>.mailbox.ts`, routed on the `To` local part with `[tag]` captures, Void's order of specificity, and the noun `Mailbox`.
   - **B** — a declaration in conduit: a `mail` receiver beside the provider's target, holding the route table from local part to handler.
   - **C** — both, split by owner: conduit's receiver owns the arrival (verify, dedupe, parse), and a `<address>.mailbox.ts` file owns what one address does with what arrived.
   - **D** — C's first half is already built and its second half is code, not a file. The arrival is an ordinary conduit `Receiver` (`FJS-D899`): the mail vendor's connector exports the `Dialect` (`conduit-postmark` parses a JSON body, a raw-MIME vendor's connector brings the MIME parser, `FJS-D784`), each parsing to ONE shape, `ReceivedMail` — junction's `MailMessage` read the other way, plus the envelope `recipient` the plus-tag rides on — owned by `@frontierjs/junction/mail` beside `MailMessage`, structurally copied by a connector as `MailMessage` already is. What an address does is the app's `apply`, with the framework supplying the kit the stressor hand-rolled: `replyAddress(base, id, secret)` mints `base+<token>@domain` and refuses a base too long to carry one, `splitAddress(address)` gives `{ base, tag }`, `readReplyTag(tag, { secret, now, ttlSeconds })` reads the token back, all over `toolbelt/signature`'s `mintToken`/`readToken` under one purpose. No file convention and no `Mailbox` noun: a mailbox someone else owns, read by delta and written back (ELA's M365 inbox, `FJS-2574`), is a sync engine and not this feature.
   - **Recommend D** — measured, not argued. The chatwoot stressor (#5) built C by hand before `FJS-D899` landed and found the file half does not fit a help desk: its addresses are ROWS (`Inbox.emailAddress`), so every route would be a capture and the file tree would hold one file that looks the inbox up (`api/src/mail/mailbox.ts`). Its `inbound.ts` is the receive order conduit now owns, line for line (record unapplied → apply → mark; `FJS-1805`), so the whole arrival half collapses onto `app.conduit.receive()`. What is left that every app would copy is the message shape and the address kit, and the shape is not new: an inbound mail has the fields `MailMessage` has, with Message-ID and In-Reply-To in `headers` where outbound already puts them. A and C coin a noun for a lookup the app owns; B puts the app's routing into conduit, which `FJS-D899` keeps vendor-only.
2. ~~**Does a token expire, and does a reply to an expired one go to the fallback handler or bounce?**~~ **Answered 2026-10-16 (`FJS-D1092`): B — it expires, and an expired token's reply goes to the fallback handler, unattributed, as a message whose `From` is a claim.**
   - **A** — no expiry: a valid signature threads the reply onto its record for as long as the record exists.
   - **B** — it expires, and an expired token's reply goes to the fallback handler, unattributed, as a message whose `From` is a claim.
   - **C** — it expires, and an expired token's reply is answered with a mailed bounce.
   - **Recommend B** — the expiry bounds how long a token forwarded or cc'd onward can speak as the person it names, and B takes away the attribution without losing the message, which on a support thread is usually still a real customer. C is not a bounce behind a webhook, where the message is already accepted; it is an outbound mail sent to whatever `From` claims, which is backscatter. Measured in the chatwoot stressor (`api/src/mail/mailbox.ts`, `test/mail.test.ts` § a token that does not verify still delivers the mail): an expired or forged tag opens a new conversation in the inbox the base address names, with `From` a claim. One refinement the stressor found: the token proves the holder RECEIVED our mail and nothing about who holds it now, so a valid token threads the reply but attributes it only when `From` is the address the mail went to; any other `From` lands on the same record as its own, unverified sender. The TTL is the app's to state, in seconds, read from the ULID's own time (`FJS-1941`) — no bits in the tag and no row to look up.
4. ~~**Where is it proved, and what does `example` show?**~~ **Answered 2026-10-16 (`FJS-D1093`): A now, B when the shape has a second asker.**
   - **A** — junction's suite alone: the address kit and the shape, with the chatwoot stressor as the only round trip.
   - **B** — junction's suite, plus `example` receives a reply to an order confirmation over `conduit-postmark`'s dialect: the mail sink posts Postmark's inbound shape at the app's receiver, and the reply lands on the order as a row — a drive beside `verify:pay` and `verify:stripe`.
   - **Recommend A now, B when the shape has a second asker** — the stressor is the measured round trip and runs over two real dialects; `example` has no model a reply lands on (`Order` has no note or message), so B invents one to demonstrate a kit, and the connector it needs is still in the sibling workspace. The ruling names the stressor's `mail.test.ts` as the drive until a connector is promoted.
3. ~~**Where does the parse happen — the provider connector, which already holds the vendor's JSON shape, or one MIME parser shared by every provider?**~~ **Answered 2026-10-09 (`FJS-D784`): A — the provider connector normalizes the vendor's payload into one message shape, the same split `FJS-D153` draws for signatures.**
   - **A** — the provider connector normalizes the vendor's payload into one message shape, the same split `FJS-D153` draws for signatures.
   - **B** — every connector hands over raw MIME, and one shared parser builds the message.
   - **Recommend A** — then a shared MIME parser the first time a connected provider hands over only raw MIME (SES), called by that connector. The vendor's shape is the connector's by `FJS-D153`, and B throws away the parse Postmark and Mailgun already did while putting a MIME parser into every app on day one.
