---
id: inbound-email
status: proposed
dated: 2026-10-07
---

# Idea — inbound email: a reply lands on the record it answers

**Status: PROPOSED. Nothing here is built and nothing is ruled.** It is the email
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
`plugins/email/types.ts`), so the outbound half exists.

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

1. What is the noun, and is it a file convention (Void's routing) or a
   declaration in conduit beside the provider it arrives from?
   - **A** — a file convention: `api/src/mailboxes/<address>.mailbox.ts`, routed on the `To` local part with `[tag]` captures, Void's order of specificity, and the noun `Mailbox`.
   - **B** — a declaration in conduit: a `mail` receiver beside the provider's target, holding the route table from local part to handler.
   - **C** — both, split by owner: conduit's receiver owns the arrival (verify, dedupe, parse), and a `<address>.mailbox.ts` file owns what one address does with what arrived.
   - **Recommend C** — which vendor delivers mail and which address answers it are two facts that change for different reasons, and `FJS-D177` already gives the first to conduit. The second follows the file convention notifications and jobs use, and `Mailbox` is the older name `FJS-D177` credits to Rails rather than a new one.
2. Does a token expire, and does a reply to an expired one go to the fallback
   handler or bounce?
   - **A** — no expiry: a valid signature threads the reply onto its record for as long as the record exists.
   - **B** — it expires, and an expired token's reply goes to the fallback handler, unattributed, as a message whose `From` is a claim.
   - **C** — it expires, and an expired token's reply is answered with a mailed bounce.
   - **Recommend B** — the expiry bounds how long a token forwarded or cc'd onward can speak as the person it names, and B takes away the attribution without losing the message, which on a support thread is usually still a real customer. C is not a bounce behind a webhook, where the message is already accepted; it is an outbound mail sent to whatever `From` claims, which is backscatter.
3. Where does the parse happen — the provider connector, which already holds the
   vendor's JSON shape, or one MIME parser shared by every provider?
   - **A** — the provider connector normalizes the vendor's payload into one message shape, the same split `FJS-D153` draws for signatures.
   - **B** — every connector hands over raw MIME, and one shared parser builds the message.
   - **Recommend A** — then a shared MIME parser the first time a connected provider hands over only raw MIME (SES), called by that connector. The vendor's shape is the connector's by `FJS-D153`, and B throws away the parse Postmark and Mailgun already did while putting a MIME parser into every app on day one.
