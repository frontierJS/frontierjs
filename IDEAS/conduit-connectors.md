---
id: conduit-connectors
status: proposed
dated: 2026-08-29
reranked: 2026-10-10
---

# Idea — which Conduit connectors FrontierJS should maintain, and in which order

**Status: PROPOSAL, prototyped.** All twenty are built as prototypes in the
sibling workspace `../conduit-connectors/`; postmark and mailgun are shaped as `packages/` members (2026-10-16) but held in the sibling workspace until the owner commits them, the rest not —
§ *Prototyped 2026-10-11* is the state of each (20 built, all 10 conduit rows closed). Dated 2026-08-29. `FJS-D153` settled
*where* an official connector lives — its own package, `@frontierjs/conduit-<vendor>`,
promoted out of `example/` once a second one exists to argue with the first. It did
not settle **which ones**, and it did not settle what a connector package actually
contains. This file answers the first and frames the second.

One thing shipped: `example/api/src/providers/stripe/index.ts`, 306 lines, driven by
`verify:stripe`. It is the only instance, which is exactly why the ruling parked
promotion.

**That sentence is six weeks stale.** § *Re-ranked 2026-10-10* below counts what the
ports and basecamp have since written in app code, and orders the list from what is
actually being called rather than from what a shop would want.

---

## The test

A connector earns FrontierJS's maintenance only if all three hold.

**One — every app needs it.** Not a vertical. If the answer to *would a shop, a SaaS
and an internal tool all reach for this* is no, it is an app's own `core/` file and
should stay one.

**Two — the hairy part is not the HTTP call.** Every vendor is a `fetch` away.
What costs a team a month is the ring of rules around the call: the signing scheme,
webhook replay and secret rotation, retry-versus-refuse, the unit money is denominated
in, a legal opt-out keyword, key rotation on a clock you do not control. If the
integration is one POST and a JSON body, an app can write it in an afternoon and a
package is overhead.

**Three — the vendor's cadence is not ours.** `FJS-D153`'s first cost. A thing that
versions on somebody else's schedule cannot sit inside a package whose version means
*what the integration mechanism guarantees*.

There is a fourth, and it applies to exactly one slot. **Does it argue with Stripe?**
The ruling parks promotion until a second connector exists, because one implementation
answers the interface questions by accident. So the second pick is chosen for maximum
disagreement rather than maximum demand — the choice is made once, and choosing the
easy second connector wastes it.

---

## The ten

| #   | Package                                 | What is actually hard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `conduit-stripe`                        | Written, live, driven. `Idempotency-Key` on the calls where a retry costs real money; minor units, where JPY has no decimals and every hand-rolled `toFixed(2)` invents one; a decline that is a **domain answer** rather than a retry; a webhook secret **rotation**, where two `v1=` values ride one header; the 3DS hand-back, which is a redirect in the middle of a server-to-server flow.                                                                                                                                                                                                                                                        |
| 2   | `conduit-s3`                            | **The argument, and the reason to build it second — and litestone already has a signer.** SigV4 signs a canonical request over a *binary* body. Stripe is a bearer key over form-encoded. `providers/psp/index.ts` is this project's own HMAC over JSON. Three dialects against one `serialize()` is the only thing that shows whether the boundary is generic. It also poses the question no other connector poses: **a presigned URL never crosses conduit at all** — the connector mints a URL the browser uses directly, so a connector is not always a caller of `send()`. One connector serves R2, B2, MinIO, Spaces and AWS, and litestone's `File` columns want a real backend under `FileStorage` — which already signs S3 through `storage/sigv4.js`, so a `conduit-s3` connector would be a SECOND owner of SigV4 rather than the first, and the two would need reconciling before either is built out further. |
| 3   | `conduit-resend` (or Postmark)          | Sending is easy; **not being blocked is not.** A bounce or complaint webhook must write a suppression list or the domain's reputation goes, DKIM/SPF/DMARC have to align, a dedicated IP needs warming, and *accepted* is three states away from *delivered*. `@frontierjs/notifications` has an email driver with no real sender under it.                                                                                                                                                                                                                                                                                                            |
| 4   | `conduit-push` (APNs + FCM)             | The missing notification transport — `packages/notifications/drivers/` holds `email.ts` and `inapp.ts` and nothing else. APNs signs its own ES256 JWT from a `.p8`, rotates it about hourly, caps the payload at 4KB, and answers `BadDeviceToken`, which means **delete the row**, not retry. FCM has different auth, a different error taxonomy, and its own idea of a topic. Device-token lifecycle is state the app must own and nothing tells you that up front.                                                                                                                                                                                  |
| 5   | `conduit-twilio`                        | The other missing transport, and the most rule-dense thing on this list. E.164 normalization, `STOP`/`HELP` keyword handling that is **legally required** and only half-handled by the vendor, 10DLC/A2P registration gating US traffic at all, and a delivery receipt that arrives on a separate webhook minutes later — so *sent* and *delivered* are two columns, not one.                                                                                                                                                                                                                                                                          |
| 6   | `conduit-oidc`                          | A protocol, not a vendor. Discovery document, PKCE, JWKS fetch with **caching and rotation**, `id_token` verification against iss/aud/nonce/exp and the alg-confusion class. `@frontierjs/auth` has OAuth; every provider's quirk is currently the app's problem — Google's `hd`, Microsoft's tenant, and Apple's client secret, which is **a signed JWT that expires every six months** and takes sign-in down when it does.                                                                                                                                                                                                                          |
| 7   | `conduit-tax` (Stripe Tax)              | `example/api/src/domain/shop/pricing.ts` carries an invented rate. Real sales tax is per-state nexus thresholds, EU OSS/VAT, reverse charge on B2B against a VIES lookup, and a tax code per product. It is also the case where **the calculation must be recorded rather than recomputed**, because a filing is made against what was charged — which is the same copy-at-the-moment-of-sale rule `verify:money` already enforces for a discount and a rate.                                                                                                                                                                                                      |
| 8   | `conduit-shipping` (EasyPost or Shippo) | `example`'s `ShippingMethod` has invented rates too. Live quotes per carrier, address validation that **changes the address you print**, a label purchase that is irreversible spend (idempotency again, for the second time on this list), a tracking webhook stream, and customs documents the moment a parcel crosses a border. An aggregator is one connector over many carriers — the same leverage as `conduit-s3`.                                                                                                                                                                                                                              |
| 9   | `conduit-anthropic`                     | SSE stream framing; a tool-call loop that is a state machine rather than a request; `429` carrying a `retry-after` that must be honored rather than backed off blindly; token accounting, because somebody is billed for it; prompt-cache TTL; and model deprecation on the vendor's clock, which is `FJS-D153`'s cadence cost in its purest form.                                                                                                                                                                                                                                                                                                    |
| 10  | `conduit-cloudflare`                    | What makes `deploy-plane.md` real. DNS records, TLS, and cache purge for a fleet that basecamp and the Outpost already command. Scoped API tokens, a proxy toggle that changes the certificate story, and a purge endpoint that is rate-limited hard enough to matter. **It has a caller waiting since 2026-08-30**: basecamp declares `IEdge` with a stub behind it and `/dns/` renders a skeleton where the zone's records go, so the shape a connector has to answer is written down rather than guessed — `packages/basecamp/docs/ADAPTERS.md`. Its sibling there, `ICloudSpend`, is a vendor billing read and is on nobody's list here, which is the honest answer: it is one app's screen, not every app's need.                                                                                                                                                                                                                                                                                                                                                                                 |

**Just under the line, and worth naming so they are not re-argued:** Slack (signing
secret and Block Kit are real, but the audience is ops rather than every app),
Basecamp (a vertical, argued in full in § *Basecamp* below, and worth reading for
what it pressed on the mechanism), a
CAPTCHA/Turnstile connector (small, but every signup form wants one), Sentry (an SDK
rather than a connector), PostHog, and identity verification (Persona, Stripe
Identity — enormous rule surface, wrong denominator).

---

## What is deliberately not on it

**Calendar, mail-as-data, and accounting (Xero, QuickBooks).** These are not
connectors. They are **sync engines** — bidirectional, stateful, with conflict
resolution and a cursor that has to survive a restart. Letting one in through the
conduit door means conduit grows a sync contract to accommodate it, which is the
`FJS-D153` inversion by another route. If they are wanted they are their own noun.

**Search (Meilisearch, Typesense).** Litestone declares `@@fts`. Adding a search
connector before FTS has been run to its limit is solving a problem the framework
does not yet have.

**Anything requiring the vendor's own SDK as a runtime dependency.** That is
`FJS-D153`'s install-weight cost arriving one package later. A connector should be
`fetch` plus types. If an SDK is genuinely required, the surface is too large to be
a connector and the answer is a different shape.

---

## The order — superseded 2026-10-10

**The live order is § *Re-ranked 2026-10-10*.** This one is kept as the record of
why the stop after S3 was placed, which the re-ranking moves rather than removes.

```
1. stripe      promote from example/ unchanged
2. s3          the ARGUMENT — the interface is designed here, not before
   ── stop. write the connector contract from what those two disagree about ──
3. resend   4. push   5. twilio      notifications gets real transports
6. oidc                              auth stops being every app's problem
7. tax      8. shipping              example/ stops lying about money
9. anthropic  10. cloudflare
```

The stop is the whole plan. `example/` currently holds `providers/psp/` (this
project's own HMAC scheme over JSON) and `providers/stripe/` (a real vendor's,
form-encoded, bearer key, its own webhook signature). Adding S3 puts a third dialect in the fight — binary
bodies, canonical-request signing, and a call that does not go through `send()` at
all. **Then** the three questions `FJS-D153` explicitly left open have three data
points instead of one:

- Does a connector **return** a `TargetDescriptor` or **install** it? (`stripeTarget()`
  returns one today. A presigned-URL minter installs nothing.)
- Does it ship a **sink** or a **fixture**? (`stripe-sink.ts` is 263 lines standing in for
  one vendor; S3 has MinIO, a real server anybody can run.)

  *Proposed:* **both, and they are not rivals.** Every connector ships a sink; a
  fixture is added where a conforming server exists to point at. The sink is the
  default because it is the only place the vendor's misbehavior can be reproduced —
  MinIO will not deliver an event twice, lose a response or move its clock when a
  test asks, and mapping that misbehavior onto `ConduitErrorKind` is most of what a
  connector is for. It is also smaller than it sounds: a sink covers the calls the
  connector makes, not the vendor's surface, so an S3 sink for a presigned-URL
  minter is a signed PUT, a GET and a HEAD, offline and without Docker in CI. The
  fixture's job is fidelity: the same drive runs against both, and a pass on the
  sink with a failure on the fixture is the sink drifting from the protocol. The
  sink owns chaos; the fixture checks the sink. quo's Telnyx sink is the case with
  no fixture at all, since nobody runs a local carrier.
- Is the webhook verifier a **function** or a **hook**? (`verifyStripeSignature()` is
  a function called from a raw route. S3 event notifications arrive differently, and
  APNs has no webhook at all.)

Answer those, extract `@frontierjs/conduit-stripe`, and 3 through 10 become
mechanical rather than architectural.

---

## Re-ranked 2026-10-10 — against what the ports actually call

The ten above were ranked from `example/` and general demand. Since then six apps
have written vendor dialects in their own `providers/`, and three live Kobami apps
(maid.tech, ELA, SSTime) have been read for what they really call. This section is
the list ordered by that evidence, in three tiers: **written and waiting for
extraction**, **a port needs it and nobody has written it**, and **every app will
want it and no port needs it yet**. The three tests above still decide what
FrontierJS maintains; a thing that fails test one is named here so it is not
re-argued, with the scope it lands under.

### Tier A — written in an app, promotion overdue

`FJS-D153` parked promotion until a second connector existed to argue with Stripe.
There are now eight, and they already disagree on every axis the stop was waiting
for: bearer over form (Stripe), bearer over JSON with Ed25519 webhooks (Telnyx),
SigV4 over bytes (S3), an envelope where a 200 can be a failure (Cloudflare), a
float of dollars (DigitalOcean), and a credential resolved per agency at send time
(DataForSEO). The connector contract can be written from these; nothing further
needs building first.

| #   | Package                 | Written where                                                                      | Who calls it                                                               |
| --- | ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `conduit-stripe`        | `example/api/src/providers/stripe/`                                                | example; Transit; serpgrid and quo plan on it; stressors #7, #11, #29      |
| 2   | `conduit-telnyx`        | `fjs-prototypes/quo/api/src/providers/telnyx/` — target, sink, Ed25519 verify, STOP | quo (#23); ELA and SSTime consume it rather than build a second (`conversion-ela.md` § 5); maid.tech wants texting |
| 3   | `conduit-s3`            | `packages/litestone/src/storage/providers/s3.js` + `storage/sigv4.js`               | litestone `File` columns; ELA's 2 GB of raw payloads; Immich (#17); every upload |
| 4   | `conduit-resend`        | `packages/junction/src/mail/index.ts` — the adapter sits INSIDE junction           | `app.mail`, notifications' email driver, SSTime, Transit, JazzHR. This is the `FJS-D153` inversion in the tree today, and moving it out is the cheapest extraction on the list |
| 5   | `conduit-cloudflare`    | `packages/basecamp/api/src/providers/edge/cloudflare.ts`, 264 lines, no longer a stub | basecamp `/dns/`; ELA and maid.tech both sit behind Cloudflare; `cloudflare-edge.md` holds promotion until a second caller, and `deploy-plane.md` is that caller |
| 6   | `conduit-digitalocean`  | `packages/basecamp/api/src/providers/compute/digitalocean.ts`                      | basecamp provisioning; `fli deploy` for anyone whose fleet is Droplets    |
| 7   | `conduit-hetzner`       | `packages/basecamp/api/src/providers/compute/hetzner.ts`                           | basecamp provisioning; the second compute dialect, which is what makes `ComputeConnector` an interface rather than one vendor's shape |
| —   | `conduit-dataforseo`    | `fjs-prototypes/serpgrid/api/src/providers/dataforseo/`                            | serpgrid only. **Fails test one** (an SEO vendor is a vertical). Stays in the app; named so it is not promoted by momentum. It is the reference for *a send that costs money and a credential resolved per tenant*, which `third-party-credentials.md` wants |

### Tier B — a port needs it, nobody has written it

| #   | Package                         | Need                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | `conduit-google-maps`           | **Four apps.** maid.tech and ELA embeds load `@googlemaps/js-api-loader`; ELA geocodes crews and clients and asks a routing lookup for drive time; SSTime maps punches; serpgrid adds a location through Places API (New) with a `X-Goog-FieldMask`. One API key, three Google surfaces (Geocoding, Places, Routes), a per-call price and a daily quota, and a result that must be CACHED by address because the second lookup of the same street costs money — `external-field-cache.md`. ksite geocodes with Nominatim today, which is the free fallback the same connector should name |
| 9   | `conduit-oidc`                  | Unchanged from row 6 above, now with callers: serpgrid needs Google OAuth with a delegated GBP grant (one agency grant serving many clients), ELA signs into Microsoft for Outlook, and `third-party-credentials.md` leg one is the credential it mints. It is the protocol connector; the GBP, Graph and Sheets calls that follow are the apps' own |
| 10  | `conduit-push` (APNs + FCM)     | Unchanged from row 4. SSTime is a time clock on a phone and ELA's crews are in the field; `notifications/drivers/` still holds `email.ts` and `inapp.ts` and nothing else. Toggl/Kimai (#36) and Connecteam (#2) need it on day one |
| —   | Service Autopilot               | **The biggest real call volume in the three live apps** — 282,075 of ELA's 305,760 recorded actions are polls of it, and maid.tech polls it too. Fails test one (field-service CRM) and is a sync engine with a cursor, which § *What is deliberately not on it* rules out of conduit. The right shape is a THIRD-PARTY connector, `@kobami/conduit-serviceautopilot`, carried by both ports, over a caravan cursor — the shape `FJS-D153`'s `@scope/` naming rule exists for. Jobber is the same case at a tenth the volume |
| —   | Microsoft Graph (Outlook mail)  | ELA reads a mailbox. Mail-as-data is a sync engine, out of conduit by the rule above; `inbound-email.md` is the framework answer, its noun still an open question there, over a provider's inbound webhook rather than a mailbox poll. The port should take that door, and the Graph read stays ELA's own if it survives |
| —   | QuickBooks                      | maid.tech. Accounting is the named sync-engine exclusion. Its own noun when wanted; not a connector |
| —   | n8n / Zapier                    | maid.tech (203 references) and ELA (222) push events out to automation. That is not a connector in either direction: outbound is junction's webhooks battery, inbound is `inbound-integrations.md` half B. The `third-party/zapier/` app maid.tech ships is a developer-API product (#29), and `prompt-to-app.md` already rules payments out of that shape |
| —   | 3CX, Attentive.ai, Radar, Cloudinary, ATTOM, DataForSEO | One app each. App-owned `providers/` files, following the Stripe shape. Named so the next audit does not count them as gaps |

### Tier C — every app will want it, no port is waiting

| #   | Package                              | Why it is general                                                                                                                                                                                                                                   |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | `conduit-anthropic` / `conduit-openai` | `junction/src/ai/index.ts` already tells an app to declare the vendor as a conduit target and shows the Anthropic descriptor in a comment. Two connectors, not one: Anthropic is a vendor; the OpenAI chat shape is a de facto PROTOCOL served by Ollama, Groq, Mistral and others, so `conduit-openai` is the protocol connector under the rule § *The open question* proposes. Base44 (#22), Portal (#6) and the chatbot all sit on it |
| 12  | `conduit-twilio`                     | The general SMS demand after Telnyx proves the shape. Same rules (E.164, `STOP`, 10DLC, delivery receipts on a later webhook); the second carrier is what shows which of those belong to a shared `sms` contract and which to a vendor |
| 13  | `conduit-postmark` (or SES)          | The second mail vendor, chosen for INBOUND: `inbound-email.md` needs a provider that delivers a parsed message to a webhook, and Resend's inbound is newer and thinner. Also the second mailer the `SendResult.id` ruling (`FJS-D684`) wants to argue with |
| 14  | `conduit-turnstile` (and hCaptcha)   | Every signup form, every contact form on every ksite client site. One POST, so it nearly fails test two — but the token is single-use, must be verified server-side with the caller's IP, and a form that skips it is spam within a day. S, and the smallest connector on the list |
| 15  | `conduit-slack`                      | Still ops-shaped, still under the line for maintenance — but Transit (58 references) and `data-layer-v1.md` X6 want report delivery to a channel, and the signing-secret and Block Kit rules are real. Promote when a second app asks |
| 16  | `conduit-plausible`                  | A read of a site's stats. Kobami's analytics check already does it from a script over every client site, and Transit holds 536 references. One bearer key, one GET, paged — fails test two on its own, passes it as the reference *read-only, rate-limited report source* that `data-layer-v1.md` names |
| 17  | `conduit-tax`, `conduit-shipping`    | Unchanged from rows 7–8. Still the only two that stop `example/` from teaching invented rates, and still no port needs either |
| —   | Basecamp (37signals)                 | Argued in full below; vertical. Kobami's own need (the daily check, the support flow) is real and is `@kobami/conduit-basecamp`, a third-party connector by the same rule as Service Autopilot |

### The order

```
A.  extract, in this order, each with its sink and its drive moving with it:
    1 stripe · 4 resend (the inversion) · 3 s3 (reconcile the two SigV4 owners first)
    2 telnyx · 5 cloudflare · 6 digitalocean · 7 hetzner
    ── stop. write the connector contract from what the eight disagree about ──
B.  8 google-maps · 9 oidc · 10 push         the three the ports are blocked on
C.  11 anthropic + openai · 12 twilio · 13 postmark · 14 turnstile
    15 slack · 16 plausible · 17 tax + shipping
```

Ruled 2026-10-10, before step A:

- **The protocol rule** — `FJS-D889`. A connector may own a protocol that more than
  one server implements, and is named for it; its drive passes against two of them.
- **What a connector package contains** — `FJS-D890`, read off the eight above. It
  binds `@frontierjs/conduit-*` only, and answers `FJS-D153`'s three questions:
  sink and fixture, return, pure-function verifier.
- **Auth goes through one signer seam** — `FJS-D891`, built (`FJS-2542`): an
  `auth: { type: 'signed', signer, ref }` target, the function the connector's. It is
  what twilio (Basic), turnstile (secret in body), push (minted JWT) and s3 sign with.
- **SigV4 moves to toolbelt** — `FJS-D892` (`FJS-2543`), because litestone cannot
  import `conduit-s3`.
---

## Prototyped 2026-10-11 — state of each

Every connector in the order above exists as a prototype package in the sibling
workspace `conduit-connectors/` (its own git repo, beside `frontierjs/`; nothing
is under `packages/` here). Each follows `FJS-D890` — target builder, payload
types, error mapping, sink, drive, verifier where the vendor sends webhooks —
against a `CONTRACT.md` written after Tier A and amended by Tier B and C.
**Audited 2026-10-13 by running every drive: 20 of 20 green**, every one against
its own sink only. No vendor was called, no key exists, no docker, so a row
that names a fixture names one wired to `FIXTURE_URL` and never run.

| Connector | Tier | How it was built | Drive | Fixture (`FJS-D889`) | Waits on |
| --- | --- | --- | --- | --- | --- |
| stripe | A | extracted from `example/api/src/providers/stripe/` | 16 rows | — | nothing; the shape the others copied |
| resend | A | extracted from junction's mail battery | 12 | — | nothing; closes the `FJS-D153` inversion |
| s3 | A | extracted from litestone `storage/`; SigV4 imported, not copied; region is `auth.params` | 12 | MinIO, SeaweedFS **unproved** | `FJS-2543` SigV4 to toolbelt; a docker run |
| telnyx | A | written new (quo not on this machine) | 10 | — | error codes checked against an account; `FJS-2571` |
| cloudflare | A | extracted from basecamp edge | 12 | — | nothing; purge-cache has no caller so is not built |
| digitalocean | A | extracted from basecamp compute | 11 | — | nothing; promote with hetzner |
| hetzner | A | extracted from basecamp compute | 12 | — | nothing |
| google-maps | B | new; two hosts, one key; `?key=` via `query` on `api_key` (`FJS-D940`) | 22 | — | Google wording unverified; Nominatim named, not built |
| oidc | B | new; `origins` on the target (`FJS-D939`), two targets for two credentials (`FJS-D933`) | 38 | **panva oidc-provider proved in-process**; Dex unproved | Apple `client_secret_basic` unverified |
| push | B | new (APNs + FCM); APNs 403 is a refusal predicate (`FJS-D941`); the FCM exchange is a send through its own target | 23 | — | APNs h2 unmeasured |
| gmail | B | new; per-user OAuth over `per_caller` | 41 | — | after oidc; batch endpoint waits on `FJS-2700` |
| anthropic | C | new | 22 | — | nothing; streams through `conduit.stream()` (`FJS-D934`) |
| openai | C | new, protocol connector; streams | 23 | Ollama, llama.cpp **unproved** | a local model server |
| twilio | C | new; the built-in Basic signer (`FJS-D933`) | 12 | — | nothing |
| postmark | C | new; inbound over a URL credential — **shaped for `packages/conduit-postmark` 2026-10-16, held in this workspace until committed** | 11 | — | nothing |
| mailgun | C | **shaped for `packages/conduit-mailgun` 2026-10-16, held in this workspace until committed**; new; the raw-MIME inbound (`fromMime` over postal-mime, `FJS-D784`), signature over `timestamp + token` with the token as nonce; `Dialect.parse` async for it | 13 | — | nothing; event webhooks, attachments on a send not built |
| turnstile | C | new; secret-in-body signer | 12 | — | nothing |
| slack | C | new; bot token + incoming webhook | 26 | — | nothing; `files.uploadV2`, `conversations.history` not built |
| plausible | C | new; the replayable read | 8 | Plausible CE **unproved** | a docker run |
| tax | C | new over conduit-stripe by relative import | 10 | — | promote after stripe |
| shipping | C | new (EasyPost) | 15 | — | nothing |

**What the prototypes found in conduit** — ten rows, `FJS-2721`–`FJS-2730`.
Eight are closed by rulings of 2026-10-12/13: `FJS-D933` (Basic is the one
built-in signer; two credentials are two targets; a throwing resolver or signer
is `auth_failed`; a per-target signing fact is `auth.params`), `FJS-D934` (http
`stream()` is the body as it arrives), `FJS-D939` (`origins` on a target),
`FJS-D940` (`query` on `api_key`), `FJS-D941` (a signer names its own refusal).
Nine connectors were moved onto those seams. The last two closed 2026-10-13:
`FJS-2722` (a mint through a second target throws `MintError`, so its failure
keeps its own `retryable`) and `FJS-2724` (`byRef()` beside `withCache`). The
contract clauses they bent are `CONTRACT.md` § Amendments there.

**Promotion wraps each verifier in a `Dialect`** (`FJS-D899`, 2026-10-15): conduit's
receiving end takes `verify(delivery, cred, { now, seenNonce }) · parse · dedupeKey`
over one `Delivery` shape (lowercased headers, `rawBody`, the parsed body), where
the prototypes' `verify<Name>Signature` take a header string (stripe), a `HeaderBag`
(slack) or a typed object (telnyx). The pure verifier stays; the dialect is the
adapter the connector exports beside it, as `example`'s `stripeDialect` does.

**Promotion order** (the reasoning is `REPORT.md` there): stripe · resend ·
turnstile · twilio · cloudflare · digitalocean + hetzner · postmark · slack,
plausible, shipping, tax · anthropic + openai · google-maps · oidc · gmail ·
push · then the ones with something still in front of them — telnyx
(`FJS-2571`), s3 (`FJS-2543`, docker). Promotion turns the two
relative imports (s3 → litestone's `sigv4.js`, tax → conduit-stripe) into
workspace dependencies and adds each package's row to the root `CLAUDE.md`
Packages table with ring `batteries`. `alongside/conduit-connectors.md` is the
lane.

---

## The open question the ruling does not cover

**Both questions below are ruled: `FJS-D889` and `FJS-D890`.** The argument is kept as
the record of why.

`FJS-D153` names connectors after vendors — `@frontierjs/conduit-stripe`, not
`@frontierjs/stripe` — and the reasoning is right. But it assumes a connector maps
to one vendor, and **two of the strongest items on this list map to a protocol
instead**: `conduit-s3` serves five storage vendors, `conduit-oidc` serves every
identity provider that publishes a discovery document. Both pass all three tests.
Both would be absurd to write five times.

That wants a line in `DECISIONS.md` before either is built, because the failure mode
is cheap to prevent and expensive to undo: without it, somebody later writes
`conduit-r2` and `conduit-b2` as near-copies of `conduit-s3`, and the third copy is
where they diverge. The rule is probably *a connector may own a protocol where the
protocol has more than one conforming implementation, and is named for the protocol* —
with the corollary that a vendor's extensions to that protocol are the app's, not
the connector's, unless a second implementation shares them.

The second unruled thing is smaller and shows up at build time: **what does a
connector package contain, minimally?** The candidate answer, from the one instance
that exists, is a target builder, the vendor's payload types, its webhook verifier,
its error mapping onto `ConduitErrorKind`, and a dev sink (with a fixture beside it
where one exists — see the sink-or-fixture question above). That is a guess made from
a sample of one, which is what the stop after S3 is for.

---

## Cost and payoff

Effort per connector is **S to M** — days for the mechanism, most of the time going
into the sink and the drive rather than the requests. The exceptions are
`conduit-oidc` and `conduit-tax`, both **M to L**, because both are mostly rules.

The payoff is not evenly spread. Items 3, 4 and 5 together are the difference between
`@frontierjs/notifications` being a real notification system and being an in-app
table with an email driver; that is the largest single jump on the list. Item 2 is
the cheapest in absolute terms and the most valuable structurally, because it is what
makes the other eight cost days. Items 7 and 8 are the ones that stop `example/` from
teaching a shop's arithmetic with numbers nobody charges.

---

## Basecamp — a vertical that pressed the mechanism

Argued 2026-09-02 for 37signals' Basecamp API (`basecamp/bc-api`), not this repo's
`packages/basecamp`, which shares only a word. **Verdict: not a maintained package**
— project management is a vertical, and it fails test one for Slack's reason. It
passes two, three and four, and the fourth is why it was worth researching.

### What it asks that Stripe never did

| | |
| --- | --- |
| Base URL | `https://3.basecampapi.com/{account_id}/` — **discovered** per user from `launchpad.37signals.com/authorization.json`, where a `TargetDescriptor.address` is declared once |
| Auth | OAuth 2; the token lives **14 days** and refreshes, long enough to work through development and fail in production |
| User-Agent | **Required**, app name and a URL or email; traffic without it is blocked |
| Rate limit | 50 requests per 10 s per IP, `429` with `Retry-After` |
| Pagination | `Link rel="next"` plus `X-Total-Count`, geared — 15, 30, 50, then 100 per page |
| Caching | `ETag`/`Last-Modified` → **304** |
| Attachments | raw binary body |
| Webhooks | per project, up to 10 attempts, and **no signature of any kind** |

Measured against conduit's transport that day, five were gaps in the mechanism
that any well-behaved REST API exposes, and all five were fixed the same day:
response headers unreachable (`FJS-648`), a 304 reported as an error (`FJS-649`),
a 429 opening the circuit breaker and `Retry-After` ignored (`FJS-650`, now its own
`rate_limited` kind), a binary body serialized as a JSON object of byte indices
(`FJS-651`), and no home for a constant per-target header (`FJS-652`). Fixing them
found `FJS-656` — a caller could displace a target's credential by spelling the
header differently — and `FJS-657`, the SQLite registry dropping `encoding`.

So Basecamp argues on axes nothing else here reaches: **response metadata as a
result**, **304 as a success**, and **a credential that expires and rewrites
itself** — the last one visible from S3 too, the first two from nothing else.

### The inbound half, where there is nothing to verify

`IConduit` receives nothing by design; the inbound leg is a junction raw route and a
verifier the connector owns (`verify:pay` proves it with no conduit in it). Basecamp
signs nothing, so the honest design says so rather than inventing a check:

- **A secret path** — `/webhooks/basecamp/{token}`, compared constant-time. It
  authenticates the URL, not the request.
- **Idempotency on `payload.id`**, since redelivery is ordinary.
- **Treat the payload as a hint and re-read the recording** with the app's own
  token. That read is the only step that establishes anything; acting on the body
  is the hole, and a forged POST to a leaked URL is indistinguishable from a real one.

A hook is per project, so the app installs one per bucket, installs another when a
project appears, and reconciles hooks deleted on Basecamp's side.

### What is still unbuilt

Mechanism is done. What an app would still need: **the credential leg's OAuth
kind** — `getFor(ref, who)` carries the principal (`FJS-D848`) and an answer its
expiry (`FJS-D1075`, one refresh per key inside `withCache`), but `TargetAuth` has
no OAuth variant until the scope derivation (`third-party-credentials.md` § Sequencing
step 4); **the connector** in `example/api/src/providers/basecamp/`, following the Stripe shape,
whose `translate()` treats 404 as *you may not see this* because visibility is per
project; and **a sink and a drive** that can move the clock rather than wait a
fortnight — a 304 served from cache, a `Link` walk to page two, a 429 that does not
open the breaker, bytes arriving as bytes, a webhook re-read before it is acted on,
and one refresh with two sends in flight.

---

## See also

- [`DECISIONS.md` `FJS-D153`](../DECISIONS.md#fjs-d153) — where a connector lives, and why not in conduit
- [`DECISIONS.md` `FJS-D31`](../DECISIONS.md#fjs-d31) — FrontierJS wraps third-party binaries; it does not fork or republish them. The same instinct one layer down
- `third-party-credentials.md` — *auth mints, conduit spends*; where a connector's credential comes from
- `deploy-plane.md` — what item 10 unblocks
- `ecosystem-gaps.md` — the comparison against Laravel's batteries
- `packages/conduit/README.md` · `packages/conduit/CLAUDE.md` — the mechanism as it ships
- `example/api/src/providers/stripe/index.ts` · `providers/psp/index.ts` — the two dialects that exist today
- `packages/basecamp/docs/ADAPTERS.md` — the app-side of item 10, and the test this list's rule three sets: four declared boundaries with nothing behind them, and which of the four is every app's problem rather than one app's
