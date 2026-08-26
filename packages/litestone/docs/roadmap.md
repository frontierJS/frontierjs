# Roadmap

What's coming, what's being considered, and what's known to need fixing.

---

## Before v1.0 publish

These block the first public release.

### Fix $rotateKey (3 failing tests)

`$rotateKey` re-encrypts all `@secret(rotate: true)` fields. There are 3 known failing tests — root cause unknown, likely a key derivation or IV reuse issue in the encryption layer. Must be resolved before publish.

### Publish to npm

Package is written and working. The unscoped name `litestone` is blocked by npm's similarity check (support ticket filed). Publishing as `@frontierjs/litestone`. Pre-publish checklist is in [publishing.md](publishing.md).

---

## High priority

### Exact numbers — `@scale(n)`, then `@money`

There is no fixed-point numeric type: `TYPE_MAP` offers `Int`, `Float` and
nothing between them, so an exact quantity is modelled as a float and hoped for.

```prisma
model Order {
  qty    Int @scale(6)      // stored 1_500_000; the point sits six places in
  total  Int @money(USD)    // scale 2, derived from the currency
}
```

`Int` and not a `Decimal` scalar, because SQLite has no column widths — the
precision half of `decimal(p, s)` emits an identical column and is `@lte`
spelled differently, so only the scale is load-bearing. Stored as an integer, it
sorts and `SUM`s exactly; it reads back in major units, which puts one rounding
at the end of an aggregate rather than one per row.

**This entry previously proposed storing a Money as JSON TEXT,
`{ "amount": 1299, "currency": "USD", "scale": 2 }`, and that is wrong rather
than merely superseded.** `opaqueSortKind` classifies a `Json` column as opaque,
so `$checkOrderBy` throws on it — the column could not be sorted, grouped or
summed, which is every question anyone asks of a money column.

Design record, with the evidence from a 188-model fixture and the two open
questions (a per-row currency, and rescaling on a scale change):
`IDEAS/declared-semantics.md` § 2.

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

### @slug — auto-slug with collision handling

```prisma
model Post {
  title String
  slug  String @slug(source: title)
}
```

Generates a URL-safe slug from `title` on create. Handles collisions by appending a suffix (`my-post-2`, `my-post-3`). Updates automatically when `title` changes (configurable).

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

### Typed JSON fields

JSON fields with a declared schema — validated on write, typed in TypeScript output.

```prisma
type Address {
  street  String
  city    String
  country String
  zip     String?
}

model User {
  address Json @type(Address)
}
```

Generates `UsersAddress` TypeScript interface. Validates structure on write. No SQL change — still stored as JSON TEXT.

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
