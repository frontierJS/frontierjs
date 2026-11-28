---
id: client-mailroom
status: proposed
dated: 2026-11-27
---

# Idea — client mailroom: one Cloudflare address per client, kept and pulled into Workbench

**Status: PROPOSAL.** Nothing is built. Two questions were answered by the
owner in conversation on 2026-11-27 (§ Ruled); they have no `FJS-D` id yet.
Do not cite this file as describing behavior — see `VERIFYING.md`.

It builds on `cloudflare-email.md` (an Email Worker in front of junction) and
`inbound-email.md` (`ReceivedMail`, the reply-tag kit). Those two are about
**one app receiving its own mail**. This one is about **one contractor
receiving mail from many clients**, keeping all of it, and reading it on the
laptop.

---

## Trigger

The owner works for several clients as an independent contractor, and each
client is one FJS app (thod, ELA, …). Today the conversation with a client is
in a personal inbox. Nothing here can read it, it is not tied to the app it is
about, and a session cannot review it. The owner asked for:

- an address per client, on a domain the owner controls, that can be routed
  anywhere;
- every message stored in Cloudflare;
- a Workbench screen that pulls the messages down on demand.

v1 is **mail only** (§ Ruled 2). A client's in-app thread, the widget that
writes it and the hand-off back to a client app come later (§ Later).

## The shape

```
client ──SMTP──▶ Cloudflare MX (<sub>.<domain>) ──▶ mailroom Worker
                                                     ├─ KV   clients: slug → name, senders, (later) app target
                                                     ├─ R2   mail/<slug>/<id>.eml   + <id>.json (parsed)
                                                     └─ D1   one row per message, id sortable by arrival
Workbench (laptop) ──GET /mail?after=<id>──▶ mailroom Worker  (bearer token)
   └─ ClientMail rows, Mail screen, "file to Basecamp"
```

1. **Addresses.** `<slug>@<sub>.<domain>`, for example `thod@mail.knight.works`.
   One catch-all rule sends the subdomain to the Worker, so a new client is a
   KV row, not a routing rule. `<slug>+<tag>@` is the same client. The tag is
   kept on the row and is what a later reply-tag hand-off reads.
2. **On arrival** the Worker parses the raw bytes once, with the shared
   `fromMime` (`FJS-D1694` moves it to `@frontierjs/conduit/mime`; this Worker
   is one more asker). It then:
   - looks the slug up in KV. An unknown slug is `setReject` (a permanent
     refusal, as `FJS-D1693` treats our own 4xx), so spam to random local parts
     never reaches storage;
   - writes `<id>.eml` (the raw bytes, the original) and `<id>.json` (the
     `ReceivedMail` plus attachment names, sizes and types) to R2;
   - inserts the D1 row. If either write fails it throws, so the sender's
     server retries (`cloudflare-email.md` 0.2 measures that a throw is an
     SMTP 4xx). Dedupe on `Message-ID` plus the recipient makes the retry safe.
3. **The D1 row:** `id` (ULID, so it sorts by arrival), `slug`, `tag`,
   `messageId`, `threadKey` (the first id in `References`, else
   `In-Reply-To`, else its own `Message-ID`), `from`, `to`, `subject`,
   `sentAt`, `receivedAt`, `preview` (the first ~200 characters of the text),
   `attachmentCount`, `size`, `knownSender` (whether `from` is on the client's
   KV list; a sender not on it is stored and flagged, not refused, because a
   client's colleague is a real sender), `r2Key`.
4. **The read API** is on the same Worker, behind one bearer secret:

   ```
   GET /mail?after=<id>&limit=100   rows, oldest first
   GET /mail/<id>                   the parsed JSON
   GET /mail/<id>/raw               the .eml
   GET /mail/<id>/att/<n>           one attachment, read out of the .eml
   ```

   Workbench calls it instead of reading D1 and R2 itself. Neither
   `conduit-cloudflare` nor `conduit-s3` speaks D1 or R2 today, so a direct
   read would be two new clients. Behind the API, the storage layout stays the
   Worker's to change.
5. **Workbench** gets a `ClientMail` model (the D1 row plus `pulledAt`,
   `readAt`, `basecampTodoId`, and the text and html bodies once fetched).
   `mail.pull` is a job and a button: it asks for everything after the newest
   `id` it already has, so pressing it twice does no harm. The Mail screen
   lists messages by client and thread, shows read and unread state and
   opens the body. An attachment is fetched only when it is opened.
6. **Review in a session.** A `client-mail` skill reads Workbench's
   `ClientMail` rows for one client and sorts what is new into answers to
   that app's open questions, issues and requests, then drafts a reply for
   the owner. No Gmail sign-in is involved.
7. **Basecamp.** Workbench already has the `bc3` provider (`FJS-D2265`), so the
   owner's Basecamp grant stays on the laptop, not in Cloudflare and not on a
   client's server. "File to Basecamp" creates a to-do in that client's
   ISSUES list (`conduit-37signals` `createTodo`) for a thread's first
   message, and comments on it (`comment`) for later ones. `basecampTodoId`
   on the row is the link.

**Not a Basecamp forwarding address.** Forwarding each mail to a project's
email-forward address was considered and set aside. A forward lands in Email
Forwards, not as a to-do. Basecamp accepts a forward only from a person on the
account, as far as is known (unmeasured), and a Cloudflare forward keeps the
client's `From`. `forward()` only sends to a verified destination, which means
clicking a verification link that arrives inside Basecamp. And the item would
not know which thread or client it came from.

**Sending is out of scope**, as in `cloudflare-email.md`. A reply goes out
through junction's SMTP mailer (`createSmtpMailer`). From a personal account,
the tagged address goes in `Reply-To`, because Gmail rewrites a `From` that is
not a verified alias. `received.ts`'s header comment says the tag rides on the
address mail is sent FROM. That comment should say `Reply-To` as well.

## Ruled

1. **Keep the Cloudflare copy.** R2 and D1 are the archive. A pull marks a row
   pulled and deletes nothing. Workbench's copy is a cache, so a lost laptop
   loses nothing. (Owner, 2026-11-27.)
2. **v1 pulls mail only.** Workbench reads the mailroom and nothing else. A
   client app's own in-app threads are not pulled. (Owner, 2026-11-27.)

## Open questions

1. **Which domain?** The owner named `knight.works` or `frontierjs.com`, or
   another. Measured 2026-11-27 with `dig`: both zones are on Cloudflare
   (`charles`/`reza`). `knight.works` receives mail at Proton
   (`mail.protonmail.ch`, `mailsec.protonmail.ch`). `frontierjs.com` has no
   MX.
   - **A**: a subdomain of `knight.works` (`mail.knight.works`). Proton keeps
     the root. `FJS-D1696` refuses the root of a zone that already has an MX,
     so the root is not an option there.
   - **B**: a subdomain of `frontierjs.com`.
   - **C**: the root of `frontierjs.com`.
   - **Recommend A, unless the owner wants clients to see the framework's
     name**, in which case B. Either way it is a subdomain: that leaves the
     root free for a real mailbox later, and keeps its MX and SPF records
     separate from anything sent from the root. Under B, client mail is
     addressed to the framework's public name rather than the contractor's.
     C uses up the root for a catch-all. Whether routing on a subdomain leaves
     a root MX untouched is probe 0.1.
2. **Where does the Worker live, and what deploys it?** `cloudflare-email.md`
   ships its forwarder as fixed source in `conduit-cloudflare`, and
   `edge.sync` deploys it per app Domain (`FJS-D1695`). The mailroom is one
   per contractor, not one per app, and it has R2, D1 and KV bindings.
   - **A**: its own private package, `packages/mailroom`, deployed by hand
     with the `cf` CLI. Its hand-off code (later) imports
     `conduit-cloudflare`'s signing.
   - **B**: grow `conduit-cloudflare`'s Worker, with optional storage
     bindings, and deploy it with `edge.sync`.
   - **Recommend A for v1.** There is one, it is the owner's, and it needs
     bindings that `edge.sync` does not manage. Fold it into B if a second
     contractor or an app wants the archive. The package name is a noun, so
     it goes through `decision-rules`.
3. **Who may email a client's address?**
   - **A**: any sender to a known slug is stored, and a sender not on the
     client's list is flagged (`knownSender: false`). An unknown slug is
     refused.
   - **B**: only senders on the client's list are accepted, and everything
     else is refused.
   - **Recommend A.** B would bounce a client's bookkeeper or a new hire.
     Revisit if spam reaches a known slug.

## Phase 0 — Measure

Goal: the Cloudflare facts this idea adds to `cloudflare-email.md` Phase 0,
which it shares (0.1 the handler fields, 0.2 throw versus `setReject`, 0.4 the
size limits).
Done when: each step has its finding indented under it.

- [ ] 0.1 Enable Email Routing on a subdomain of a zone whose root MX is elsewhere, and diff the root's MX and SPF before and after
- [ ] 0.2 Inside the email handler, write a 20 MiB message to R2 and a row to D1, and record the wall-clock and CPU time
- [ ] 0.3 Check that a catch-all on the subdomain receives `slug+tag@` with the tag intact in `message.to`

## Phase 1 — The Worker

Goal: mail to a known slug is stored, and mail to an unknown one is refused.
Done when: the package's test runs the handler against a fake `message` and
in-memory R2, D1 and KV, with rows for a known slug, an unknown slug, a
`+tag`, a redelivered `Message-ID`, an unknown sender and a failed write; and
a live mail from an outside account appears in `GET /mail`.

- [ ] 1.1 Package per Q2, with bindings and the bearer secret
- [ ] 1.2 Email handler: slug lookup, parse, R2 then D1, dedupe, throw on a failed write
- [ ] 1.3 Read API, the four routes, and a 401 without the bearer
- [ ] 1.4 Deploy, a routing rule on the domain from Q1, and the `thod` slug

## Phase 2 — Workbench

Goal: the owner pulls mail and reads it on the laptop.
Done when: a drive sends a real mail, presses Pull, opens the message on the
Mail screen and opens an attachment, and a second Pull adds nothing.

- [ ] 2.1 `ClientMail` model, migration, and the mailroom URL and token in Workbench's env
- [ ] 2.2 `mail.pull` job and button, resuming after the newest id
- [ ] 2.3 Mail screen: by client and thread, read and unread, body, attachments on demand

## Phase 3 — Review and Basecamp

Goal: a session reviews a client's new mail, and a thread becomes a to-do.
Done when: the skill summarizes thod's new mail against
`discovery/open-questions.md`, and "File to Basecamp" creates one to-do for a
thread and comments for its later messages, against `conduit-37signals`'s sink
and then the real account.

- [ ] 3.1 `client-mail` skill over Workbench's rows
- [ ] 3.2 File to Basecamp through the `bc3` provider: a to-do, then comments, with `findCreated` before any second try (creates have no idempotency key)

## Later (not v1)

- **Hand-off to the client's app.** The KV row gains the app's receive URL and
  secret. After storing, the Worker POSTs the raw bytes to that app, signed as
  `cloudflare-email.md` specifies, and `cloudflareMailDialect` and the app's
  `apply` thread a tagged reply onto its record. Because the mail is already
  stored, a failed hand-off retries from R2: `FJS-D1693`'s C, scoped to this
  Worker.
- **In-app threads** (the widget a client writes in from a screen, after ELA's
  `SupportThread`, and `anchored-feedback.md` for a site preview) and pulling
  them into Workbench, which § Ruled 2 left out of v1.
- **A card table** instead of to-dos. `conduit-37signals` has no card calls yet.
