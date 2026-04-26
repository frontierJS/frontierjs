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

### Money type

A first-class monetary value type that eliminates float precision bugs.

```prisma
model Order {
  total   Money
  refund  Money?
}
```

Stored as JSON TEXT: `{ "amount": 1299, "currency": "USD", "scale": 2 }`. Read back as `{ amount: 12.99, currency: 'USD', formatted: '$12.99' }`. Arithmetic (`add`, `subtract`, `multiply`) via the Money helper. Locale-aware formatting.

### Embedding(n) — vector search

Store and query high-dimensional embeddings. Useful for semantic search, recommendations, and RAG pipelines.

```prisma
model Document {
  id        Integer @id
  content   Text
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
  id       Integer @id
  address  Text
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
  title Text
  slug  Text @slug(source: title)
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
  street  Text
  city    Text
  country Text
  zip     Text?
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

### Schema-level transitions (@@transitions)

Formal state machine definitions at the schema level:

```prisma
model Order {
  status Text @default("draft")
  @@transitions([
    { name: "submit",  from: ["draft"],     to: "pending" },
    { name: "approve", from: ["pending"],   to: "approved" },
    { name: "cancel",  from: ["draft", "pending"], to: "cancelled" },
  ])
}
```

Enforced by the ORM — attempting an illegal transition throws a `TransitionError`. Currently available as manual validation via computed fields.

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
