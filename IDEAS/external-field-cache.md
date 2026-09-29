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

- The noun.
- Whether this is a litestone attribute at all, or a conduit target writing an
  ordinary column on a schedule — which needs no language change.
