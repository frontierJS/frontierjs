---
id: conduit-basecamp
status: proposed
dated: 2026-09-02
---

# Idea — a Basecamp connection, and what it asks of the outbound boundary

**Status: PROPOSAL. Nothing here is built.** Dated 2026-09-02. It answers a
question asked of `basecamp/bc-api` — 37signals' Basecamp API, not this repo's
own `packages/basecamp`, which is unrelated and shares only a word.

Two halves, and the second is the one that pays. The first is *what a Basecamp
connector would contain*, which is ordinary. The second is **what Basecamp
presses on conduit that Stripe never did** — five gaps in the mechanism, all
vendor-agnostic, all measured against the shipped transport rather than read off
it. Those were filed as [`FJS-648`](../ISSUES.md#fjs-648) through
[`FJS-652`](../ISSUES.md#fjs-652) and closed the same day — worth closing whether
or not a line of Basecamp code is ever written, which is the point.

Vendor facts were fetched from `basecamp/bc-api` on 2026-09-02 and are quoted
with their numbers. Claims about this tree were **run** (`VERIFYING.md`); the
probe output is inline.

> **The five findings below were FIXED the same day. Read § What the mechanism
> cannot do today as dated evidence, not as current behavior.** `FJS-648`
> (response headers), `FJS-649` (304 as a success), `FJS-650` (`rate_limited` and
> `Retry-After`), `FJS-651` (binary bodies) and `FJS-652` (constant per-target
> headers) are all closed, and fixing them turned up two more that are also
> closed: `FJS-656`, where a caller could join or displace a target's credential
> by spelling the header differently, and `FJS-657`, where the SQLite registry
> silently dropped `encoding`. The measurements are kept verbatim because they are
> why the fixes exist and what a regression would look like. **What is still true**
> is everything else: the vendor's facts, the connector's shape, the unsigned
> webhook design, the three tests, and the credential leg, which is unbuilt.

---

## The question underneath it: is conduit one-way?

Yes, deliberately — and *the connector is not*.

`IConduit` is `send` · `stream` · `register` · `resolve` · `list` · `touch`
(`packages/conduit/src/types.ts`). Nothing on it receives. That is the package's
shape and not an omission: `IDEAS/third-party-credentials.md` § The frame already
splits an integration into three legs, and the inbound one has a different owner —
a junction raw route, `ctx.$raw.rawBody`, and a verifier the connector owns.
`example`'s `verify:pay` proves that leg end to end with no conduit anywhere in
it.

So *conduit is one-way* and *a connector is two-way* are both true and are not in
tension. `example/api/src/providers/stripe/index.ts` opens by saying so — "the
Stripe connection, **both directions**" — and its `verifyStripeSignature()` never
touches `send()`.

Two things are easy to confuse with it and neither is inbound-from-a-provider.
Junction's `webhooks` plugin is **outbound** — webhooks this app delivers to
partners, signed with `@frontierjs/toolbelt/signature`. And conduit's `stream()`
is an outbound request whose response arrives in chunks, not a subscription.

Where Basecamp makes this interesting is that it has **no signature at all**, so
the inbound leg cannot be *verify and act*. See § The inbound half below.

---

## What Basecamp is

| | |
| --- | --- |
| Base URL | `https://3.basecampapi.com/{account_id}/`; every path ends `.json` |
| Auth | OAuth 2 at `launchpad.37signals.com` — `/authorization/new`, `/authorization/token` |
| Token lifetime | **1,209,600 s — 14 days**, with a refresh token |
| Identity | `GET launchpad.37signals.com/authorization.json` → `identity.id`, `expires_at`, and `accounts[]` with an `href` per account |
| User-Agent | **Required**, app name *and* a URL or email. They block traffic without it |
| Rate limit | **50 requests per 10 s per IP**, `429` carrying `Retry-After` |
| Pagination | `Link` `rel="next"` (RFC 5988) plus `X-Total-Count`; **geared** — 15 results on page 1, 30 on 2, 50 on 3, 100 thereafter |
| Caching | `ETag` / `Last-Modified` back as `If-None-Match` / `If-Modified-Since` → **304** |
| Attachments | `POST /attachments.json?name=…` with the file's **raw binary** as the body, `Content-Type` and `Content-Length` set; answers an `attachable_sgid` to embed in rich text |
| Webhooks | `POST /buckets/{id}/webhooks.json` — **per project**, up to 10 delivery attempts, 2xx only, and **no signature, HMAC or shared secret of any kind** |

Three of those rows are unlike anything in this repo. The base URL is
**discovered** — `accounts[].href` comes back per user and a person may hold
several — where a `TargetDescriptor.address` is declared once at startup. The
credential **expires on a fortnight's clock** and rewrites itself. And the
webhook is unauthenticated by design.

---

## What the mechanism cannot do today

Measured 2026-09-02 against `packages/conduit/src/` with a real Bun server on the
other end. Not read off the source.

**1 — A response's headers are unreachable.** `ResponseMeta` is
`{protocol, target, status, duration_ms}` and the transport never puts a header
on it. Probed against a server answering `ETag`, `Link` and `X-Total-Count`:

```
meta: {"protocol":"http","target":"bc","status":200,"duration_ms":8}
```

All three are read and discarded. Basecamp pages by `Link` and counts by
`X-Total-Count`, so **a connector cannot fetch page two** — not awkwardly, at
all. [`FJS-648`](../ISSUES.md#fjs-648).

**2 — A 304 is an error.** `if (!res.ok)` catches everything outside 200–299, so
a conditional request that succeeded in the only way it can succeed comes back as
a failure:

```
304 → {"kind":"server_error","retryable":false,"message":"HTTP 304"}
```

Basecamp's documentation asks callers to make conditional requests. Doing so
against conduit turns every cache hit into a refusal.
[`FJS-649`](../ISSUES.md#fjs-649).

**3 — `Retry-After` is parsed nowhere and 429 opens the breaker.** A 429 is
mapped to `server_error` with the header stuffed into `error.raw` as a string,
and the backoff table is a fixed `[500, 1500, 1500]` with jitter. Probed against a
server answering `Retry-After: 7`:

```
retried after 396 ms and 1385 ms   (the vendor asked for 7000)
```

The second half is worse than the impatience. `server_error` is in the set that
implicates the target (`resilience.ts`), so five rate-limited answers open the
circuit and every subsequent send fails `circuit_open` for the reset window —
load shedding triggered by the one status that means *slow down*, not *I am
broken*. [`FJS-650`](../ISSUES.md#fjs-650).

**4 — A binary body cannot be sent.** `encodeBody` returns a `string` and knows
`json` and `form`. Probed with a four-byte PNG header:

```
on the wire: {"0":137,"1":80,"2":78,"3":71}   content-type: application/json
```

Which is a JSON object of byte indices, sent confidently. Basecamp's attachment
upload wants the raw bytes. This is the same gap `IDEAS/conduit-connectors.md`
predicted `conduit-s3` would expose — arriving early, and from inside an
otherwise ordinary JSON API. [`FJS-651`](../ISSUES.md#fjs-651).

**5 — A target cannot carry a constant header.** `TargetDescriptor` grew
`encoding` because *how this one encodes* is a fact about who is on the other
end; `User-Agent` is the same kind of fact and has nowhere to live, so it is
spread onto every call the way `stripe.ts` spreads `Stripe-Version`. For Stripe
that is a tidiness cost. For Basecamp the header is required and its absence gets
the traffic blocked, so the one call somebody writes without it is a production
incident. [`FJS-652`](../ISSUES.md#fjs-652).

**And the sixth, which is already on the roadmap rather than in the register.**
`CredentialResolver.get(ref)` takes no principal, returns no expiry, and
`TargetAuth` has no OAuth variant. A 14-day per-user token that must refresh is
exactly legs one and three of `IDEAS/third-party-credentials.md`, unbuilt and
ranked at `IDEAS/overview.md` 2.2. Nothing new is learnt here; Basecamp is simply
a caller that cannot be written without it. The lifetime is worth noting on its
own, because fourteen days is long enough to work through development and fail in
production with nothing saying why — the failure shape this repo is most hostile
to.

---

## What the connector would contain

```
example/api/src/providers/basecamp/
  index.ts   the target · the User-Agent · account discovery ·
             typed reads · error translation · the webhook payload types
  sink.ts    a stand-in Basecamp on 8115 (the next free slot in example's row)
```

The target is ordinary apart from the address, which is the account-less origin
because the account id is per-caller and belongs in the path:

```ts
export function basecampTarget(): TargetDescriptor {
  return {
    id:            BASECAMP_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       BASECAMP_URL,          // https://3.basecampapi.com
    encoding:      'json',
    auth:          { type: 'bearer', ref: 'BASECAMP_ACCESS_TOKEN' },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}
```

The `ref` is honest only for a single-account, single-user installation. Anything
else needs the credential leg, and the connector should refuse rather than send
as whoever the environment happens to hold — junction's `$` throws outside a
service call, which is the failure mode that argument turns on.

`translate()` follows `stripe.ts`: conduit classifies by status, which is right
for a transport and wrong for a domain. Basecamp's own guidance is that 5xx is
retryable and 404 is not, and 404 additionally means *you may not see this*
rather than *this is gone*, because a person's visibility varies per project.

---

## The inbound half, where there is no signature

Basecamp signs nothing. So the verifier this repo would reach for does not exist
and cannot be written, and the honest design says so rather than inventing a
check that proves nothing. Three layers instead, and the third is the one that
matters:

**A secret path.** `/webhooks/basecamp/{token}`, compared constant-time, with the
token registered in the `payload_url` when the hook is created. This is the whole
of what Basecamp's model offers, and it authenticates the URL rather than the
request.

**Idempotency on `payload.id`.** Delivery is up to ten attempts and only a 2xx
counts, so a redelivery is ordinary rather than exceptional.

**Treat the payload as a hint and re-read the recording.** The body carries
`recording.url`; fetching it with the app's own token is an authenticated read,
and it is the only step in the flow that establishes anything. An unsigned
webhook can be trusted to say *something happened over there* and cannot be
trusted to say *what*. Acting on the body directly is the hole, and it is silent:
a forged POST to a leaked URL is indistinguishable from a real one.

Two consequences are worth stating because they are state, not configuration. A
hook is **per project**, so the app enumerates buckets, installs one each, and
installs another whenever a project appears — nothing pushes that. And the app
must reconcile: a hook deleted in Basecamp's UI stops delivering with no notice
here.

---

## Does it earn a `@frontierjs/` package?

Against `IDEAS/conduit-connectors.md` § The test:

| | |
| --- | --- |
| **One — every app needs it** | **No.** Project management is a vertical. It sits with Slack, which that file puts just under the line for the same reason: the audience is ops rather than every app |
| **Two — the hairy part is not the call** | Yes. A refreshing per-user token, unsigned webhooks, geared pagination, 50-per-10s |
| **Three — the vendor's cadence is not ours** | Yes |
| **Four — does it argue with Stripe** | **Yes, and on axes nothing else on that list reaches** |

The fourth is the finding. `conduit-s3` was picked as the second connector
because it argues about signing and about a call that never goes through `send()`.
Basecamp argues about three different things: **response metadata as a
first-class result** (Link, ETag, X-Total-Count), **304 as a success**, and **a
credential that expires and rewrites itself**. None of those is visible from
Stripe, and only the third is visible from S3.

So the recommendation is: **not a maintained package, and not a rival to S3 for
the second slot.** Build it as an app-owned connector if an app needs Basecamp,
and treat this document's five findings as what it was worth researching for.
They are gaps in the mechanism that any well-behaved REST API exposes; Basecamp is
merely the first thing to press all five at once.

---

## The plan

**Phase 1 — the mechanism, with no Basecamp code in it. DONE 2026-09-02.**
[`FJS-648`](../ISSUES.md#fjs-648) response headers ·
[`FJS-649`](../ISSUES.md#fjs-649) 304 as a success ·
[`FJS-650`](../ISSUES.md#fjs-650) `rate_limited` as its own kind, honouring
`Retry-After` and out of the breaker's set ·
[`FJS-651`](../ISSUES.md#fjs-651) a binary encoding ·
[`FJS-652`](../ISSUES.md#fjs-652) constant per-target headers.

Each is small and each is testable inside `packages/conduit` against a local
server, which is how they were measured. Phase 1 is what makes every later
connector cost days — the same argument that file makes for building S3 second.

**Phase 2 — the credential leg.** `IDEAS/third-party-credentials.md`'s legs one
and three, in its stated order: a principal in `get()`, an expiry in the return,
an OAuth variant on `TargetAuth`, and refresh under a lock so two concurrent
sends do not both spend the refresh token. Basecamp is a good first user, and a
poor first *test* — a fortnight is too long to watch — so the drive has to be
able to move the clock rather than wait for it.

**Phase 3 — the connector.** The target, the account discovery, four or five
typed reads, the error translation, the webhook handler.

**Phase 4 — the sink and the drive.** `sink.ts` on 8115, `verify:basecamp` under
bun. Its assertions are the ones nothing else here can make: a 304 answered out
of cache, a `Link` walk onto page two, a 429 that honors `Retry-After` and does
**not** open the breaker, an attachment whose bytes arrive as bytes, a webhook
accepted only through the secret path **and** re-read before it is acted on, and
a token refreshed mid-drive with two sends in flight and only one refresh.

---

## See also

- [`ISSUES.md`](../ISSUES.md) `FJS-648`–`FJS-652` — the five mechanism gaps this was researched for
- [`conduit-connectors.md`](conduit-connectors.md) — which connectors this project would maintain, and the three tests applied above
- [`third-party-credentials.md`](third-party-credentials.md) — *auth mints, conduit spends*; legs one and three, unbuilt
- [`DECISIONS.md` `FJS-D153`](../DECISIONS.md#fjs-d153) — where a connector lives, and why not inside conduit
- `example/api/src/providers/stripe/index.ts` — the one connector that exists, and the shape phase 3 follows
- `packages/conduit/CLAUDE.md` — the mechanism as it ships
