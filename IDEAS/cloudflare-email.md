---
id: cloudflare-email
status: proposed
dated: 2026-10-30
---

# Idea — Cloudflare Email Routing as an inbound mail vendor

**Status: PROPOSAL.** Nothing built; Q1–Q4 ruled 2026-10-30 (`FJS-D1693`–`D1696`), and 0.1 is next. A third vendor under `inbound-email.md`
(`FJS-D1091`): mail for an app's domain lands at Cloudflare, and arrives at
junction as an ordinary conduit `Receiver` that hands the app one
`ReceivedMail`. The app's `apply`, `splitAddress` and `readReplyTag` do not
change. Every vendor-specific piece lives in `conduit-cloudflare`.

**Why Cloudflare:** the zone is often already there. Basecamp's `edge` service
writes its DNS (`cloudflare-edge.md`), and Email Routing costs nothing and needs
no vendor account. Postmark and Mailgun each need a paid account and an MX
handed to them.

---

## What is different from Postmark and Mailgun

**Cloudflare does not POST anything.** A routing rule has three possible
actions: forward to a verified address, drop, or run an **Email Worker**. A
webhook only exists if we write the Worker that sends it. That makes the hop
half ours:

```
sender MTA ──SMTP──▶ Cloudflare MX ──▶ Email Worker ──HTTPS POST──▶ junction
                                        (ours, in conduit-cloudflare)   conduit Receiver
                                                                         → cloudflareMailDialect
                                                                         → fromMime → ReceivedMail
                                                                         → app's apply
```

- **We choose the wire format,** so it should be one that conduit already
  verifies instead of a new scheme. The Worker signs in the Standard Webhooks
  form (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256),
  which `receive.ts` already names as a dedupe source. The body is the raw
  RFC 5322 bytes (`message.raw`). The envelope goes in two headers, because
  the bytes do not carry it: `x-envelope-to` (`message.to`) and
  `x-envelope-from` (`message.from`).
- **The parse is already built.** `conduit-mailgun`'s `fromMime(bytes,
  envelope)` is the raw-MIME parser `FJS-D784` named, and SES was meant to
  import it. Cloudflare is the second raw-MIME asker. By FJS-D784's own rule,
  two askers move it out of `conduit-mailgun` (Q2).
- **Rejection at SMTP time is possible here.** `inbound-email.md` § What does
  not carry over is right about a webhook vendor: the message has already been
  accepted. An Email Worker runs while the SMTP session is still open, so
  `message.setReject(reason)` gives the sender a real bounce from Cloudflare,
  not backscatter from us. That is worth something, and it also adds a choice
  about what an outage does (Q1).

## The pieces

1. **The Worker** is a short `email(message, env, ctx)` handler shipped as
   source by `conduit-cloudflare`, about 40 lines with no dependencies. It
   reads `message.raw` into bytes, signs them, and POSTs to `env.TARGET_URL`.
   A 2xx accepts the mail. Anything else follows Q1. Its secret
   (`env.SIGNING_SECRET`) is a Worker secret, and `env.TARGET_URL` is a plain
   var.
2. **`cloudflareMailDialect`** goes in `conduit-cloudflare`. `verify` checks the
   Standard Webhooks signature and timestamp window. `parse` calls
   `fromMime(body, { recipient: x-envelope-to, sender: x-envelope-from })`.
   `dedupeKey` is `Message-ID` plus the recipient, because one mail cc'd to two
   of our addresses is two deliveries (`received.ts`); `webhook-id` is the
   fallback for a mail with no Message-ID.
3. **The zone wiring** uses the account token (`FJS-D558`) and three API
   calls, next to the DNS writes `edge` already makes:
   - Enable Email Routing on the zone. Cloudflare adds its MX and SPF records,
     and `edge`'s marked-record ownership must leave those alone (Q4).
   - Upload the Worker script (basecamp's `providers/platform/cloudflare.ts`
     already reads `/workers/scripts`) and set its secret.
   - Write the routing rule. A catch-all pointing at the Worker is the
     default, because chatwoot showed that inbox addresses are rows, not
     config (`FJS-D1091`).
4. **The app's half** is one declaration, the same as for the other two
   vendors:
   `app.conduit.receive({ provider: 'cloudflare-mail', path: '/mail/cloudflare', dialect: cloudflareMailDialect, credential: 'cloudflare-mail', apply })`.

**Sending is out of scope.** Outbound stays on junction's mailer
(SMTP/Postmark/Resend). The Worker's `send_email` binding has been limited to
verified destination addresses, and Cloudflare's sending product is too
recent to depend on. Phase 0 checks where it stands, and it gets its own idea
if it becomes real.

## Open questions

1. ~~**When junction is down or answers 5xx, what does the Worker do with the mail?**~~ **Answered 2026-10-30 ([`FJS-D1693`](../DECISIONS.md#fjs-d1693)): B, else C. A permanent refusal is `setReject`.**
   - **A**: `setReject`. The sender gets a bounce, we keep nothing, and the
     mail is lost from our side.
   - **B**: throw. If Cloudflare turns an uncaught Worker error into an SMTP
     4xx, the sender's MTA retries for hours or days and the sender's queue is
     our buffer. Whether it does is Phase 0's first probe.
   - **C**: write the raw bytes to R2 (or a Cloudflare Queue) and accept. A
     consumer retries the POST until junction answers, and the mail survives
     any outage up to retention.
   - **Recommend B if 0.2 shows a 4xx, C if it does not.** B costs nothing and
     uses the sender's own retry. C adds a bucket or queue and a consumer for
     every app. A should never be the default for mail a person wrote.
   - Whatever is picked, a **permanent** refusal (our 4xx: unknown recipient,
     bad signature) is a `setReject`, not a throw, so the sender does not
     retry something that will never land.
   - Under B, an outage leaves nothing in our system: the sender finds out
     days later and the app never does. The Worker should log each non-2xx
     to Workers Logs, and a drive should keep asserting 0.2's 4xx, because
     B's premise is Cloudflare behavior that could change.
2. ~~**Where does `fromMime` live once it has two askers?**~~ **Answered 2026-10-30 ([`FJS-D1694`](../DECISIONS.md#fjs-d1694)): B, a shared home.**
   - **A**: `conduit-cloudflare` imports it from `conduit-mailgun`, so
     connector depends on connector.
   - **B**: it moves to `@frontierjs/conduit/mime` (or a `conduit-mime`
     package), and postal-mime becomes a dependency of whatever hosts it.
   - **C**: copy it.
   - **Recommend B**: `FJS-D784` said "until two askers move it", and this is
     the second one. A ties Cloudflare to Mailgun's release cycle. C is the
     two `mailbox()` copies again.
3. ~~**Who triggers the zone calls: `fli` at deploy, or basecamp's `edge` when a Domain is marked for mail?**~~ **Answered 2026-10-30 ([`FJS-D1695`](../DECISIONS.md#fjs-d1695)): B, `edge.sync`.**
   The three calls (2.1) are written once, in `conduit-cloudflare`. Whichever
   runner is picked calls that one owner (Invariant 4), with its own
   credential, the split `FJS-D1687` already made for the site Worker.
   - **A**: a `fli` deploy step beside `08c-site`, using the person's token.
   - **B**: basecamp's `edge.sync`, triggered by a mail flag on the `Domain`
     row the way DNS is pushed today, using the workspace edge token.
   - **Recommend B**: the zone and the token already live there, and drift
     (Worker missing, rule changed by hand) is the same check DNS drift
     already runs. The Worker is fixed source with no build, so it is
     simpler than the site Worker. A laptop step is how an MX gets forgotten.
     Not checked: whether the edge token has Workers-write scope (0.3).
4. ~~**How do Cloudflare's own MX/SPF records coexist with `edge`'s marked-record ownership?**~~ **Answered 2026-10-30 ([`FJS-D1696`](../DECISIONS.md#fjs-d1696)): A, plus the three conditions.**
   - **A**: `edge` treats them as unmarked and never touches them.
   - **B**: `edge` writes them itself, marked, and enables routing without
     letting Cloudflare add its own.
   - **Recommend A, plus three conditions.** A alone fails `FJS-D560`: an
     unmarked record is reported as drift, so Cloudflare's MX and SPF would be
     a drift line on every sync that nobody can clear.
     - **An allowance:** `owns` names the records routing writes as an
       expected unmarked class (`cloudflare-email`), and drift skips them.
     - **Refuse an existing MX:** enabling routing replaces the root MX, so a
       zone that already has one (a client on Google Workspace) is refused,
       not silently cut over. That is `D560`'s owed "refuse" case, and it gets
       a drive row in 2.2.
     - **One owner for SPF:** two SPF TXT records at the root are invalid. If
       the outbound mailer needs an `include:`, the merge into Cloudflare's
       record needs a named owner. If that owner has to be `edge`, reopen
       toward B.

## Phase 0 — Measure Cloudflare

Goal: the facts this idea assumes, checked against a real zone (`_fjs-test*`
on awe.dev, the hand-run zone).
Done when: each step below has its finding indented under it.

- [ ] 0.1 Route a test address to a hello-world Email Worker and log `message.from`, `.to`, `.rawSize` and the first bytes of `.raw`
- [ ] 0.2 Throw from the Worker, then call `setReject`, and read what the sending MTA records for each (4xx or 5xx). This decides Q1.
- [ ] 0.3 Enable routing through the API and diff the zone's records before and after, the SPF TXT included. Check whether the edge token can write Workers. This decides Q4.
- [ ] 0.4 Measure the wall-clock and CPU limits on a POST of a 20 MiB message (Email Routing's size cap is 25 MiB)
- [ ] 0.5 Check the current state of `send_email` and Cloudflare's sending product. Record it; nothing gets built from it.

## Phase 1 — The dialect

Goal: a signed raw-MIME POST becomes a `ReceivedMail` through conduit.
Done when: `conduit-cloudflare`'s `test` script drives the dialect through `@frontierjs/conduit/testing`, with rows for good signature, bad signature, stale timestamp, redelivery, and one mail to two recipients.

- [ ] 1.1 Move `fromMime` per Q2
- [ ] 1.2 `cloudflareMailDialect`: verify, parse, dedupeKey
- [ ] 1.3 The Worker source as an export, plus a test that runs its handler against a fake `message` and a fake `fetch` and checks the request it signs

## Phase 2 — The zone

Goal: marking a Domain for mail leaves its zone routing to a deployed Worker.
Done when: a drive marks a test Domain, then reads back the routing rule, the Worker script and its secret through the API, and reports drift once the rule is deleted by hand.

- [ ] 2.1 Enable-routing, upload-script and write-rule calls in `conduit-cloudflare`
- [ ] 2.2 `edge.sync` wiring per Q3, with drift on the three, the `cloudflare-email` allowance, and a refusal on a zone that already has an MX (Q4)
- [ ] 2.3 Q1's outage path (nothing extra under B; under C, the bucket and its consumer)

## Phase 3 — The round trip

Goal: a real mail sent to a real address lands on its record.
Done when: the chatwoot stressor's `mail.test.ts` gains a Cloudflare row, and a live mail from an outside account threads a reply onto a conversation.

- [ ] 3.1 Chatwoot declares the third receiver
- [ ] 3.2 Live mail through `_fjs-test*`, both a fresh mail and a reply carrying a tag
