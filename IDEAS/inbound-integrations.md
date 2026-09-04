---
id: inbound-integrations
status: proposed
dated: 2026-09-02
---

# Idea — receiving: two features, two owners

**Status: the DIRECTION is ruled ([`FJS-D177`](../DECISIONS.md#fjs-d177), 2026-09-02);
the MECHANISM is a proposal and nothing here is built.** Read the two halves
differently: conduit holding the relationship, the who-dials axis, the
whose-scheme-is-it split, the three exclusions and the two records are settled and
must not be relitigated here. The shape of the receiver record, the toolbelt
change and § Order are unbuilt design. It replaces the framing of
`IDEAS/overview.md` 2.13, which is right that nothing receives and treats
*receiving* as one gap; it is two, they have different owners, and confusing them
is how a webhook mints a session.

Claims about the tree were run or grepped, not read off a doc.

---

## The reframe: direction is the wrong axis

*Ruled — [`FJS-D177`](../DECISIONS.md#fjs-d177). Kept here as the argument behind it.*

Conduit has been described as *the outbound boundary* since it was written, and
**no ruling ever said so**. `FJS-D153` uses the phrase twice, both times as a
premise inside an argument about vendor coupling — never as a decision about
direction. Grep DECISIONS.md: those are the only two occurrences.

It is an artefact of origin. Conduit began as basecamp's fleet arm, and telling a
machine to deploy is outbound by nature; the README still opens on it — *"carries
Hub control-plane commands (deploy, pull, stop, sync)"*.

And it was never literally true. `stream()` yields chunks; every `send()` reads a
response. Data arrives constantly. What conduit does not do is **listen**.

> The axis is not *which direction do bytes move*. It is **who dials**.

That distinction is real and decides three things at once — **who retries** (the
dialer's choice, against the callee's problem), **who authenticates whom** (we
prove ourselves, against they prove themselves), and **whether a listening socket
exists at all**. Which is why one coherent package hides under the old name:
*the connections this process initiates*, where retry, breaker, deadline, pool and
a credential-we-spend all hang together.

It is not the package conduit's own documents describe. They claim *one place
lists what this process may talk to* — and **talk to is a relationship, not a
dialing direction**. Stripe is one counterparty holding two of our secrets and
dialing us about as often as we dial it. Under the relationship reading, one-way
is incoherent, and the relationship reading is the one worth having: it is where
n8n, Zapier, Apache Camel and MuleSoft all independently landed. Camel is the
sharpest — a Component *is* an integration point, `from()` consumes and `to()`
produces, one declaration vocabulary.

**So conduit holds the relationship, and the relationship has two ends.**

---

## But receiving is two features, and only one of them is conduit's

The test that separates them is one question: **whose scheme is it?**

| | **A — our own scheme** | **B — a counterparty's scheme** |
| --- | --- | --- |
| Who signs | us, and we handed out the secret | them, in their own dialect |
| Example | a partner posting back to an app that subscribed them | Stripe `t=…,v1=…` · GitHub `X-Hub-Signature-256` · Basecamp **nothing at all** |
| Verification | `verifyRequest({ prefix: 'X-Webhook' })` — one implementation, forever | one per vendor, and a connector owns it (`FJS-D153`) |
| Is the counterparty declared? | no — a registration is a ROW | yes — it is the other end of a declared relationship |
| **Owner** | **junction, core** | **conduit** |

**A is junction completing a symmetry it already half-built.** The `webhooks`
plugin is outbound only — `register(url, events)` registers a *subscriber*, the
architecture comment reads bus → pending row → deliver → retry → dead, and every
mention of "receiver" in that file is about the far side. It signs with
`@frontierjs/toolbelt/signature`; the missing half is the same scheme read in the
other direction. An app must get that **without installing conduit**, because it
is the second half of a feature junction already ships.

**B is conduit's relationship growing its other end.** The dialect is the vendor's,
the secret is the second of a pair the vendor issued, and the counterparty is
already declared. It is the same line `FJS-D153` drew outbound: conduit owns the
mechanism — the route, the raw bytes, the freshness window, the dedupe key, the
refusal taxonomy — and the connector owns *how this vendor signs*.

---

## B is not a second kind of target

`TargetDescriptor` describes **a place we send to**. A webhook has no such place;
it has a route of **theirs to us**. Forcing one record to be both is how a type
grows six optional fields that are meaningless half the time — and it is the cost
Camel actually pays, whose URI model leaks precisely because a component's
consumer and producer options diverge and one string carries both.

Two records, one relationship:

```
integration 'stripe'
  ├── target     address · auth · encoding          ← ships today, unchanged
  └── receiver   path · verify · window · dedupe    ← new
```

One counterparty, one credential store, two runtime paths that share no code.

---

## What goes in toolbelt

The rule asked for out loud: **anything both A and B need is a kit, or the two
drift on the one thing that must not** — `@frontierjs/toolbelt/signature` already
exists for exactly this reason, and it exists because a signer with no verifier
read as a scheme being enforced (`FJS-349`, where three fleet endpoints took no
credential at all).

Present and reusable as-is: `canonicalRequest`, `signRequest`, `verifyRequest`
(freshness before the compare, so a stale replay costs no HMAC; constant-time
compare; the length checked first so a mismatch is not an oracle), and
`occurrenceKey` in `/history` for *this delivery already happened*.

**One thing is missing and both halves need it: verification against MORE THAN ONE
SECRET.** `verifyRequest({ secret })` takes exactly one, so there is no way to
rotate a secret without an outage — which is not a vendor quirk, it is the ordinary
lifecycle of any shared secret. Stripe solved it by riding two `v1=` values on one
header, and `example`'s connector already handles that case; junction's own scheme
has no answer at all. `secrets: string[]`, tried in order, first match wins,
constant-time throughout.

**What may NOT go in toolbelt is a nonce store.** That is I/O, and the package's
whole standing — importable by litestone and mesa — is that it computes only what
it is given (`FJS-D26`).

---

## What must not merge, and what receiving must never do

**Resilience does not cross.** Retry, breaker, deadline and the concurrency cap are
ours because *we* chose to dial. Inbound, the retry is **theirs**, and our only
jobs are to be idempotent and answer 2xx quickly. A breaker has no inbound
meaning; an inbound branch inside `resilience.ts` is the first sign this went
wrong.

**A receiver must never mint a principal.** This is the guardrail that pays for
itself. `FJS-371` is a *different* gap — a machine caller **becoming a principal**,
which is an auth door and stays junction's — and from outside it looks identical
to a verified webhook. It is not. Stripe is not a caller with a session; it is an
event we verified and then act on **as the system**. Conflating them is how a
webhook ends up minting a session, and neither feature here may produce a
`SessionContext`.

**Three things are out of scope by name**, so the edge of what was taken is
decidable: a machine identity (`FJS-371`), inbound email (Rails made that its own
noun, `ActionMailbox`, and was right to), and a polled feed, which is a cursor
rather than a route.

---

## Order

**1 — the credential seam.** `IDEAS/third-party-credentials.md` leg three. It is
the only genuinely shared machinery between the two ends of a relationship, so it
is the load-bearing half of the whole argument for merging. Built second, the
receiver gets written against a resolver that cannot hold a per-user expiring
credential anyway.

**2 — `verifyRequest({ secrets })`.** One kit change, no consumer yet, and it is
what stops A and B each inventing rotation.

**3 — A, in junction.** Smaller, symmetric with code that already ships, and it
gives an app that never installs conduit a receiving half.

**4 — B, in conduit.** The receiver record, the route, the window, the dedupe.

**5 — move `example`'s hand-rolled Stripe route onto it.** `verify:pay` already
asserts four separate refusals against the hand-rolled version — a forged
signature, a swapped body, a clock outside the window, a replayed nonce — plus a
redelivered event. That drive is the acceptance test for B, and it exists before
the feature.

---

## What this costs the docs, before any code

Conduit's stated role changes from *the outbound boundary* to *the third-party
integrations an app declares* — outbound shipped, inbound declared and not built.
`ARCHITECT.md` domain 4 is already renamed to **Integrations** on that footing.
What must NOT change is `FJS-D153`: a connector still owns its vendor's dialect,
in both directions, and a vendor still does not live inside conduit.

---

## See also

- [`overview.md`](overview.md) 2.13 — *Inbound integrations*, the row this splits in two
- [`third-party-credentials.md`](third-party-credentials.md) — *auth mints, conduit spends*; step 1 above
- [`conduit-basecamp.md`](conduit-basecamp.md) — the counterparty that signs nothing, and why a receiver's guarantee is sometimes *re-read the record*
- [`conduit-connectors.md`](conduit-connectors.md) — which connectors FrontierJS maintains
- [`DECISIONS.md` `FJS-D177`](../DECISIONS.md#fjs-d177) — **the ruling this file argues for**: conduit holds the relationship, the axis is who dials
- [`DECISIONS.md` `FJS-D153`](../DECISIONS.md#fjs-d153) — the mechanism/vendor line, which holds unchanged in the new direction
- [`ISSUES.md` `FJS-371`](../ISSUES.md#fjs-371) — the machine-principal gap this is deliberately not
- `packages/junction/src/plugins/webhooks/index.ts` — the outbound half of A, shipped
- `packages/toolbelt/src/signature/signature.js` — the shared primitive, and the one-secret limit
