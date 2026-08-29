# Roadmap

What's coming, what's being considered, and what's known to need fixing.

**This file is a list of proposals and it is never a statement about what the
package does.** Three of its entries described features that had already shipped,
and a session reading them concluded the language could not express money and
filed a defect against a settled ruling (`FJS-560`). What litestone actually
accepts is [reference.snapshot.md](reference.snapshot.md) and
[../catalog.snapshot.md](../catalog.snapshot.md), both generated; an entry here
that names an attribute those already carry is stale or is an EXTENSION of it,
and must say which. `fli check`'s `roadmap-shipped` grades that.

---

## Shipped

Kept here as tombstones, at the top, because the failure this file caused was a
reader taking a proposal for the current state.

### ~~Exact numbers — `@scale(n)`, then `@money`~~ — SHIPPED

**RULED [`FJS-D142`](../../../DECISIONS.md#fjs-d142) 2026-08-25, BUILT
2026-08-26.** `Int @scale(n)` and `Int @money(CUR | field: col | )` ship. The
page is [exact-numbers.md](exact-numbers.md).

`Int` and **not** a `Decimal` scalar, and that is the settled part rather than a
compromise: SQLite has no column widths, so the `p` of `decimal(p, s)` emits an
identical column and only the scale is load-bearing — and Prisma, which HAS the
type, records that there is no reliable way to store one on SQLite, values being
written and read back different (`prisma#20635`). What comes back in JS is the
integer. The scale of money is the currency's, read off `Intl` rather than
shipped as a table. Rounding and allocation stay the application's.

Still open from the ruling: **changing `n`**, which is the one migration here
that rewrites stored bytes.

### ~~Typed JSON fields~~ — SHIPPED

`Json @type(TypeName)` ships against a `type` declared in the seed, validated on
write. The page is [json-types.md](json-types.md); the entry is
[reference.snapshot.md](reference.snapshot.md#type-field).

---

## Before v1.0 publish

These block the first public release.

### Fix $rotateKey (3 failing tests)

`$rotateKey` re-encrypts all `@secret(rotate: true)` fields. There are 3 known failing tests — root cause unknown, likely a key derivation or IV reuse issue in the encryption layer. Must be resolved before publish.

### Publish to npm

Package is written and working. The unscoped name `litestone` is blocked by npm's similarity check (support ticket filed). Publishing as `@frontierjs/litestone`. Pre-publish checklist is in [publishing.md](publishing.md).

---

## High priority

### Embedding(n) — vector search

Store and query high-dimensional embeddings. Useful for semantic search, recommendations, and RAG pipelines.

```prisma
model Document {
  id        Int @id
  content   String
  embedding Embedding(1536)
}
```

Stored as BLOB (float32 array). Requires `sqlite-vec` extension. Queries via `findSimilar()`:

```js
const results = await db.document.findSimilar({
  vector:    await embed(query),
  limit:     10,
  threshold: 0.8,   // cosine similarity
})
```

Plugin handles auto-embedding on write (pass an `embed` function to the plugin config).

### LatLng type + findNear()

A geographic coordinate type with proximity queries.

```prisma
model Property {
  id       Int @id
  address  String
  location LatLng
}
```

Stored as JSON TEXT `{ "lat": 37.7749, "lng": -122.4194 }`. Queries via `findNear()`:

```js
const nearby = await db.property.findNear({
  lat:      37.7749,
  lng:      -122.4194,
  radiusKm: 5,
  limit:    20,
  orderBy:  'distance',  // adds a `distance` field to results
})
```

Haversine formula in JS — no SQLite extension required.

---

## Medium priority

### `@slug` collision handling — the attribute SHIPS, this half does not

`@slug` ships and slugifies the column on write; the parenthesised form calls a
`function slug` the schema declares. See
[reference.snapshot.md](reference.snapshot.md#slug-field).

What is unbuilt is everything AROUND the transform:

```prisma
model Post {
  title String
  slug  String @slug(source: title)   // sourcing from a sibling — unbuilt
}
```

- **sourcing from a sibling column**, rather than slugifying this column's own value
- **collision handling** — appending a suffix (`my-post-2`, `my-post-3`), which
  needs a read inside the write and therefore a rule about what it collides against
- **re-slugging when the source changes**, which is a decision about URLs that
  already exist and not a default anyone can pick for an app

### ExternalSyncPlugin / @sync

An HTTP-backed field type. Value fetched from an external API and cached in SQLite. Invalidated on write or TTL expiry.

```prisma
model User {
  stripeCustomer Json @sync(via: "stripe")
}
```

Useful for enrichment data (Stripe, HubSpot, Clearbit) you want queryable locally without a full ETL pipeline.

### resolveMany() — polymorphic batch resolver

Batch-loads multiple models by a polymorphic nullable FK in one SQL query, eliminating N+1 patterns in polymorphic relations.

```js
// Without resolveMany: N queries (one per distinct model type)
// With resolveMany: 1 query per model type
const resolved = await db.resolveMany(items, {
  field:  'relatedId',
  type:   'relatedType',
  models: { post: 'posts', comment: 'comments', user: 'users' },
})
```

### introspect.js — emit @@db(name)

When introspecting a multi-database schema, emit `@@db(name)` on models if the target database is known at introspect time (e.g., from a litestone.config.js in the same directory).

### jsonschema.js — views support

`generateJsonSchema()` currently skips `@@external` models. Views should be included with a read-only flag in the output schema.

---

## Under consideration

### CREATOR level — clearer documentation

Level 3 (`CREATOR`) is intended for "submit but can't manage" patterns: public forms, free-tier users, external contributors who can create records but can't update or delete them. In practice, most apps jump straight from `VISITOR` (1) to `USER` (4).

Decision: document the intended use case more clearly rather than removing the level, since removing it would be a breaking change once published.

### Multi-region read replicas

Route read queries to a geographically closer SQLite replica synced via Litestream. Adds `readReplicas` config option to `createClient`. Low priority — most SQLite use cases are single-region.

### Query result caching

In-process LRU cache for read queries. Cache keyed by model + where args + version counter (incremented on any write to that model). Optional, opt-in per model.

```js
db.product.findMany({ cache: { ttl: 60 } })
```

---

## Known issues

| Issue | Status |
|---|---|
| `$rotateKey` — 3 failing tests, encryption bug | Blocking v1.0 |
| npm unscoped name `litestone` blocked by similarity check | Support ticket filed |
