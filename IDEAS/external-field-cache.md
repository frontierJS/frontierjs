---
id: external-field-cache
status: proposed
dated: 2026-09-29
---

# Idea — a field whose value is fetched from a third party and cached

**Status: PROPOSED, unargued.** Moved from `packages/litestone/docs/roadmap.md`
(where it was *ExternalSyncPlugin / `@sync`*) when that file was retired.

An HTTP-backed field: the value is fetched from an external API, cached in
SQLite, and invalidated on write or TTL expiry. Useful for enrichment data
(Stripe, HubSpot, Clearbit) an app wants queryable locally without an ETL pipeline.

```lite
model User {
  stripeCustomer Json @sync(via: "stripe")   // the old sketch — the word is taken
}
```

## What is already settled against it

- **The word is taken.** `@@sync(policy)` is offline device sync and ships. One
  name over two unrelated mechanisms is what *familiarity vs. precision* refuses,
  so this needs its own noun before it needs an implementation.
- **The call is not litestone's.** A connector to a named vendor is the app's
  (`FJS-D153`), and third parties are declared in conduit. What litestone could
  own is the CACHE and its invalidation, never the fetch.

## Open questions

- ~~**The noun.**~~ **Answered 2026-10-09 (`FJS-D783`): A — none: if the next question lands on an ordinary column, there is no new thing to name.**
  - **A** — none: if the next question lands on an ordinary column, there is no new
    thing to name.
  - **B** — `@fetched(via: "stripe", ttl: 1d)`, a field attribute that says where the
    value comes from and how long it stays.
  - **Recommend A** — it follows the next question's recommendation, and a noun
    coined before the mechanism is chosen enlarges the concept budget for nothing.
    B is the spelling to start from if the attribute route is ever taken.
- Whether this is a litestone attribute at all, or a conduit target writing an
  ordinary column on a schedule — which needs no language change.
  - **A** — a litestone attribute: litestone owns the cached column, its TTL and its
    invalidation, and a conduit target does the fetch.
  - **B** — no language change: a Caravan job calls a conduit target and writes an
    ordinary column on a schedule.
  - **C** — an `ExternalRefPlugin` subclass the app writes, which ships: a field
    type resolved on read, with `cacheKey` caching the answer.
  - **Recommend B** — every piece already has its owner: Caravan the clock
    (`FJS-D36`), conduit the third party (`FJS-D153`), litestone the column. The
    value lands stored, so it is queryable locally, which is the point of the
    idea; C resolves on read and is not. A is worth pricing only once several apps
    write the same job by hand.
