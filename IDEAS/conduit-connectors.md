---
id: conduit-connectors
status: proposed
dated: 2026-08-29
---

# Idea — which Conduit connectors FrontierJS should maintain, and in which order

**Status: PROPOSAL. Nothing here is built.** Dated 2026-08-29. `FJS-D153` settled
*where* an official connector lives — its own package, `@frontierjs/conduit-<vendor>`,
promoted out of `example/` once a second one exists to argue with the first. It did
not settle **which ones**, and it did not settle what a connector package actually
contains. This file answers the first and frames the second.

One thing shipped: `example/api/src/providers/stripe/index.ts`, 306 lines, driven by
`verify:stripe`. It is the only instance, which is exactly why the ruling parked
promotion.

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
*what the outbound boundary guarantees*.

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
| 2   | `conduit-s3`                            | **The argument, and the reason to build it second.** SigV4 signs a canonical request over a *binary* body. Stripe is a bearer key over form-encoded. `psp.ts` is this project's own HMAC over JSON. Three dialects against one `serialise()` is the only thing that shows whether the boundary is generic. It also poses the question no other connector poses: **a presigned URL never crosses conduit at all** — the connector mints a URL the browser uses directly, so a connector is not always a caller of `send()`. One connector serves R2, B2, MinIO, Spaces and AWS, and litestone's `File` columns want a real backend under `FileStorage`. |
| 3   | `conduit-resend` (or Postmark)          | Sending is easy; **not being blocked is not.** A bounce or complaint webhook must write a suppression list or the domain's reputation goes, DKIM/SPF/DMARC have to align, a dedicated IP needs warming, and *accepted* is three states away from *delivered*. `@frontierjs/notifications` has an email driver with no real sender under it.                                                                                                                                                                                                                                                                                                            |
| 4   | `conduit-push` (APNs + FCM)             | The missing notification transport — `packages/notifications/drivers/` holds `email.ts` and `inapp.ts` and nothing else. APNs signs its own ES256 JWT from a `.p8`, rotates it about hourly, caps the payload at 4KB, and answers `BadDeviceToken`, which means **delete the row**, not retry. FCM has different auth, a different error taxonomy, and its own idea of a topic. Device-token lifecycle is state the app must own and nothing tells you that up front.                                                                                                                                                                                  |
| 5   | `conduit-twilio`                        | The other missing transport, and the most rule-dense thing on this list. E.164 normalisation, `STOP`/`HELP` keyword handling that is **legally required** and only half-handled by the vendor, 10DLC/A2P registration gating US traffic at all, and a delivery receipt that arrives on a separate webhook minutes later — so *sent* and *delivered* are two columns, not one.                                                                                                                                                                                                                                                                          |
| 6   | `conduit-oidc`                          | A protocol, not a vendor. Discovery document, PKCE, JWKS fetch with **caching and rotation**, `id_token` verification against iss/aud/nonce/exp and the alg-confusion class. `@frontierjs/auth` has OAuth; every provider's quirk is currently the app's problem — Google's `hd`, Microsoft's tenant, and Apple's client secret, which is **a signed JWT that expires every six months** and takes sign-in down when it does.                                                                                                                                                                                                                          |
| 7   | `conduit-tax` (Stripe Tax)              | `example/api/src/domain/shop/pricing.ts` carries an invented rate. Real sales tax is per-state nexus thresholds, EU OSS/VAT, reverse charge on B2B against a VIES lookup, and a tax code per product. It is also the case where **the calculation must be recorded rather than recomputed**, because a filing is made against what was charged — which is the same copy-at-the-moment-of-sale rule `verify:money` already enforces for a discount and a rate.                                                                                                                                                                                                      |
| 8   | `conduit-shipping` (EasyPost or Shippo) | `example`'s `ShippingMethod` has invented rates too. Live quotes per carrier, address validation that **changes the address you print**, a label purchase that is irreversible spend (idempotency again, for the second time on this list), a tracking webhook stream, and customs documents the moment a parcel crosses a border. An aggregator is one connector over many carriers — the same leverage as `conduit-s3`.                                                                                                                                                                                                                              |
| 9   | `conduit-anthropic`                     | SSE stream framing; a tool-call loop that is a state machine rather than a request; `429` carrying a `retry-after` that must be honoured rather than backed off blindly; token accounting, because somebody is billed for it; prompt-cache TTL; and model deprecation on the vendor's clock, which is `FJS-D153`'s cadence cost in its purest form.                                                                                                                                                                                                                                                                                                    |
| 10  | `conduit-cloudflare`                    | What makes `deploy-plane.md` real. DNS records, TLS, and cache purge for a fleet that basecamp and the Outpost already command. Scoped API tokens, a proxy toggle that changes the certificate story, and a purge endpoint that is rate-limited hard enough to matter. **It has a caller waiting since 2026-08-30**: basecamp declares `IEdge` with a stub behind it and `/dns/` renders a skeleton where the zone's records go, so the shape a connector has to answer is written down rather than guessed — `packages/basecamp/docs/ADAPTERS.md`. Its sibling there, `ICloudSpend`, is a vendor billing read and is on nobody's list here, which is the honest answer: it is one app's screen, not every app's need.                                                                                                                                                                                                                                                                                                                                                                                 |

**Just under the line, and worth naming so they are not re-argued:** Slack (signing
secret and Block Kit are real, but the audience is ops rather than every app), a
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

## The order

```
1. stripe      promote from example/ unchanged
2. s3          the ARGUMENT — the interface is designed here, not before
   ── stop. write the connector contract from what those two disagree about ──
3. resend   4. push   5. twilio      notifications gets real transports
6. oidc                              auth stops being every app's problem
7. tax      8. shipping              example/ stops lying about money
9. anthropic  10. cloudflare
```

The stop is the whole plan. `example/` currently holds `psp.ts` (this project's own
HMAC scheme over JSON) and `stripe.ts` (a real vendor's, form-encoded, bearer key,
its own webhook signature). Adding S3 puts a third dialect in the fight — binary
bodies, canonical-request signing, and a call that does not go through `send()` at
all. **Then** the three questions `FJS-D153` explicitly left open have three data
points instead of one:

- Does a connector **return** a `TargetDescriptor` or **install** it? (`stripeTarget()`
  returns one today. A presigned-URL minter installs nothing.)
- Does it ship a **sink** or a **fixture**? (`stripe-sink.ts` is 263 lines standing in for
  one vendor; S3 has MinIO, a real server anybody can run.)
- Is the webhook verifier a **function** or a **hook**? (`verifyStripeSignature()` is
  a function called from a raw route. S3 event notifications arrive differently, and
  APNs has no webhook at all.)

Answer those, extract `@frontierjs/conduit-stripe`, and 3 through 10 become
mechanical rather than architectural.

---

## The open question the ruling does not cover

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
its error mapping onto `ConduitErrorKind`, and a dev sink. That is a guess made from
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

## See also

- [`DECISIONS.md` `FJS-D153`](../DECISIONS.md#fjs-d153) — where a connector lives, and why not in conduit
- [`DECISIONS.md` `FJS-D31`](../DECISIONS.md#fjs-d31) — FrontierJS wraps third-party binaries; it does not fork or republish them. The same instinct one layer down
- `third-party-credentials.md` — *auth mints, conduit spends*; where a connector's credential comes from
- `deploy-plane.md` — what item 10 unblocks
- `ecosystem-gaps.md` — the comparison against Laravel's batteries
- `packages/conduit/README.md` · `packages/conduit/CLAUDE.md` — the mechanism as it ships
- `example/api/src/providers/stripe/index.ts` · `psp.ts` — the two dialects that exist today
- `packages/basecamp/docs/ADAPTERS.md` — the app-side of item 10, and the test this list's rule three sets: four declared boundaries with nothing behind them, and which of the four is every app's problem rather than one app's
