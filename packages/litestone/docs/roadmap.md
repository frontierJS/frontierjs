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

### ~~$rotateKey — 3 failing tests~~ — FIXED

Carried here as a release blocker long after it stopped being one. `$rotateKey`
refuses while a column it cannot carry exists and rotates nothing, and runs one
transaction per DATABASE (`FJS-253`, `FJS-714`). 32 tests across
`test/key-rotation.test.ts` and the main suite.

**A fixed DEFECT is tombstoned where a shipped ATTRIBUTE is not**, and the
difference is what grades it: `roadmap-shipped` reads the generated catalog, so
a proposal for a word that now exists fails the check on its own. A bug this
file called blocking is invisible to that, and reads as current until somebody
runs the tests.

### ~~jsonschema — views support~~ — SHIPPED

`generateJsonSchema()` emits a `$def` per `view` with its own `x-gate`, in the
definition table rather than a list of its own (`FJS-999`). `@@external` models
were never skipped either, which is the half of the old entry that was simply
wrong. The page is [jsonschema.md](jsonschema.md).

### ~~A JSON-path spelling for `@@index`~~ — ALREADY EXPRESSIBLE, NOT BUILT

Proposed as `@@index([address->'$.city'])`. It is not built and should not be:
`@generated` plus an ordinary `@@index` already says it, from the schema, today.

```lite
city String @generated("addr ->> 'city'")
@@index([city])
```
```
"city" TEXT GENERATED ALWAYS AS (addr ->> 'city') VIRTUAL
SEARCH place USING INDEX idx_place_city (city=?)
```

A `->` operator would be a second spelling for a sentence the language already
has, and would coin a token to save six characters. What the proposal was really
reaching for is GRADING — opaque SQL is checked against the `Json @type(T)`
declaration by nothing — and that is answered by three `advise` rules rather
than by a word (litestone CHANGES 2026-09-20). If those rules turn out to be too
narrow in practice, the coining question comes back with evidence behind it.

The page is [json-types.md](json-types.md) § Performance characteristics.

### ~~`litestone validate`~~ — SHIPPED

Walks the stored rows and reports the ones the schema would now refuse. The page
is [validate.md](validate.md). It grew past the backlog line that asked for it
(*typed-JSON shape mismatches*) once the failure was measured: a `type` gaining
a required member does not leave stale rows lying about, it makes every one of
them **unwritable**, and the refusal names a column the caller never sent. Typed
JSON is one of eight boundary validators with no CHECK behind it, and running
the validator the write boundary already runs covers all eight for less code
than a typed-JSON-specific walker.

### ~~Publish to npm~~ — SHIPPED

`@frontierjs/litestone` publishes. The unscoped name is still blocked and is in
§ Known issues, which is where a thing nobody can act on belongs.

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
  threshold: 0.8,   // cosine DISTANCE — measured, 0 is identical and 2 is opposite
})
```

Plugin handles auto-embedding on write (pass an `embed` function to the plugin config).

**Argued** in [`IDEAS/chat-surface.md`](../../../IDEAS/chat-surface.md) § Part 2,
where the claim is that the gate and the row policies apply to retrieval for
free — a passage the caller may not read cannot ground an answer. The cost is
not the column: `sqlite-vec` is a loadable extension, so this is a distribution
question before it is a language one.

**The block above is SUPERSEDED BY RULING — read
[`IDEAS/embedding.md`](../../../IDEAS/embedding.md) and treat nothing here as the
design.** Measured 2026-09-20: the wasm engine carries `OMIT_LOAD_EXTENSION`, so
the extension is server-only by construction and is an optional accelerator rather
than the mechanism (`FJS-D331`); `vec0` measures no faster than a plain scan at
0.1.9, which is exact brute force, so the virtual table is refused. The
declaration is `embedding Bytes @vector(1536)` and not a parameterized scalar
(`FJS-D332`), retrieval is `orderBy: { embedding: { near: v } }` on `findMany`
and not a `findSimilar()` verb (`FJS-D333`), the distance is returned on the row
instead of a `threshold` option (`FJS-D329`, and the `threshold` above was
inverted — the function is a distance), the column is out of the default `select`
(`FJS-D328`), and the caller holds the query vector rather than litestone calling
a model (`FJS-D330`).

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

Haversine formula in JS — no SQLite extension required, which makes this the
smaller of the two by a wide margin.

**Unargued**, and that is the blocker rather than the code.
[`IDEAS/package-map.md`](../../../IDEAS/package-map.md) records geo as a gap
with no home and zero hits in the tree, and
[`IDEAS/stressors.md`](../../../IDEAS/stressors.md) has it as *named, unargued*.
A paper comes before a column: where the distance math lives (a toolbelt kit, on
the `/units` precedent), and whether `orderBy: 'distance'` is a directive or a
fourth thing a query may sort by.

---

## Medium priority

### `@slug` collision handling — the attribute SHIPS, this half does not

`@slug` ships and slugifies the column on write; the parenthesized form calls a
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

**The word is taken.** `@@sync(policy)` is offline device sync and ships —
[reference.snapshot.md](reference.snapshot.md#sync-model). One name over two
unrelated mechanisms is what *familiarity vs. precision* refuses, so this
proposal needs its own noun before it needs an implementation. The vendor half
is settled elsewhere: a connector to a named vendor is the app's, per
[`FJS-D153`](../../../DECISIONS.md#fjs-d153), so what litestone could own here
is the CACHE and its invalidation and never the call.

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
| npm unscoped name `litestone` blocked by similarity check | Support ticket filed, not chased. `@frontierjs/litestone` publishes regardless |
