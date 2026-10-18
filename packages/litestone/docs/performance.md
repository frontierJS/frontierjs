# Performance

Litestone is designed for SQLite's single-writer, multi-reader model. Most performance work is done for you, but understanding the architecture helps when tuning.

The examples on this page use this schema:

```lite
database audit {
  path   "./audit.db"
  driver trail
}

model Account {
  id   Int    @id
  name String

  @@gate(0)
}

model User {
  id        Int       @id
  email     String    @unique
  name      String?
  accountId Int?
  deletedAt DateTime?
  @@softDelete
  @@index([accountId])

  @@gate(0)
}

model Order {
  id          Int    @id
  accountId   Int
  orderNumber Int
  status      String @default("new")
  amount      Int    @default(0)
  @@index([accountId])
  @@index([accountId, status])
  @@unique([accountId, orderNumber])

  @@gate(0)
}
```

## What to expect

`bench/` holds the measurements — `bench/PERFORMANCE_AUDIT.md` is the write-up
and `bench/ablation.mjs` the harness — and a number printed here would be stale
by the next commit. The shape of the answer is stable:

- **Reading is essentially free.** On a large result set Litestone is within a
  small fraction of raw `bun:sqlite` — the cost is row hydration, and that is
  irreducible.
- **`findUnique` is the hottest per-request operation** and has its own prepared
  statement. Its cost is the async function machinery, the soft-delete clause,
  the plugin check and the statement call itself; the query builder is not on
  that path. of overhead beyond raw SQLite — about as low as it gets without dropping the abstraction.

## Hot paths

Litestone precomputes prepared statements at `createClient()` for two patterns that cover most reads:

**`findMany({})` fast path.** A no-args `findMany` on a `@@softDelete` table runs through one precomputed statement (`_fastFindManySql`), with no `buildSQL` call and no select/include parsing, when nothing narrows the read for this caller — no `@@trail`, no `@edge` namespace, and the soft-delete filter not altered by the call. A plugin's `beforeRead` (the gate) still runs first. Adds the soft-delete `WHERE deletedAt IS NULL` automatically.

**`findUnique` PK fast path.** `findUnique({ where: { <pk>: value } })` — the most common per-request operation — skips the query builder. The statement is prepared once at table-build time (`_fastFindUniqueSql`). Conditions: a single-column `@id`, no field-level `@allow`, no `@from` field, no `@edge` namespace, and the soft-delete filter not altered by the call. Try-guarded for `@@external` tables, which may not exist yet.

You don't need to do anything to hit these paths — they are the default when the conditions match. A feature that turns one off (a field policy, a `@from`) sends the read through the regular path, which is correct and slower.

## Statement cache

Every prepared statement is cached by SQL string. The cache is per connection (`wrapDb` in `src/core/databases.js`), LRU-bounded (`maxCacheSize`, default 500). On overflow the least-recently-used statement is evicted and finalized. This matters in long-lived processes that build many distinct WHERE shapes.

The bound is high enough that almost no workload reaches it under normal use. If one does, restructure queries to reuse shapes — a parameterized `IN (?, ?, ?)` of a fixed width rather than a dynamic-length list, which is a new statement per length.

## ANALYZE runs automatically

After every successful `migrate apply` or `autoMigrate`, Litestone runs `ANALYZE` to populate `sqlite_stat1`. The query planner uses these stats to choose the right index for selective predicates — without them it falls back to coarse heuristics that often miss the optimal index on multi-index tables.

This is a SQLite-specific edge. Postgres handles this via autovacuum; SQLite has no equivalent, so most ORMs skip it.

If you load a lot of data outside of migrations (bulk imports, seeders) and queries start hitting bad plans, run it manually:

```js
db.$rawDbs.main.run('ANALYZE')
```

Cheap (milliseconds on most tables). Worth running after any large data shift.

## WAL mode and dual connections

Litestone opens two connections per database:
- **Write connection** — exclusive writer, WAL mode, `BEGIN IMMEDIATE` transactions
- **Read connection** — `query_only` pragma, reads never block writes

This eliminates the common SQLite bottleneck where a read blocks a write or vice versa.

```js
db.$rawDbs              // { main: Database }  — the write connections
await db.$walStatus()   // { busy, frames, checkpointed } — WAL frames since the last full checkpoint
```


## Read-only clients

Open a client that can only read — any attempt to write throws immediately. The
file has to exist already, since a read-only open creates nothing:

```js
const seed = await createClient({ path: './schema.lite', db: './app.db' })
await seed.$close()

const db = await createClient({ path: './schema.lite', db: './app.db', readOnly: true })
await db.user.findMany()                         // ✓ []
```

```js throws
const seed = await createClient({ path: './schema.lite', db: './app.db' })
await seed.$close()

const db = await createClient({ path: './schema.lite', db: './app.db', readOnly: true })
await db.user.create({ data: { email: 'a@example.com' } })   // ✗ Database 'main' is readonly in this client
```


Useful for:
- Analytics or reporting processes that should never modify app data
- Background read jobs running alongside the main app
- Exposing a query interface without any write surface

Multiple read-only clients pointing at the same file are fine — SQLite WAL supports unlimited concurrent readers with no contention. Per-database granularity is available via `access:` if you only want some databases to be read-only:

```js
// main read-only, audit fully accessible
const seed = await createClient({ path: './schema.lite', db: './app.db' })
await seed.$close()

const db = await createClient({
  path:   './schema.lite',
  db:     './app.db',
  access: { main: 'readonly', audit: 'readwrite' },
})
console.log(db.$databases.main.access)   // 'readonly'
```
 present.


## select: false

Skip `RETURNING *` and result parsing entirely on writes when you don't need the row back:

```js
// Uses writeDb.run() instead of .get() — no RETURNING clause, no row parsing
await db.order.create({ data: { accountId: 1, orderNumber: 1, amount: 100 }, select: false })   // → null
await db.order.update({ where: { id: 1 }, data: { status: 'paid' }, select: false })           // → null
```

Most useful in hot write paths (bulk processing, event ingestion). On a `@@trail` model the result is still `null` but the `RETURNING` runs anyway — the before/after images need the row ([onquery-logging.md](onquery-logging.md)).

## NULLS FIRST / LAST

Avoid in-memory sorting for nullable fields by pushing NULLs to a predictable position:

```js
await db.user.findMany({ orderBy: { name: { dir: 'asc', nulls: 'last' } } })
```

Without this, SQLite puts NULLs first in ascending order and last in descending.

## Partial indexes

Litestone automatically creates partial indexes on `@@softDelete` models:

```sql
CREATE INDEX "idx_user_accountId" ON "user" ("accountId") WHERE "deletedAt" IS NULL
```

This means indexes only cover live rows — smaller, faster, and `WHERE deletedAt IS NULL` is always index-covered.

### Declaring one

```lite
model Note {
  id         Int       @id
  kind       String
  archivedAt DateTime?

  @@index([kind], where: archivedAt == null)
}
```

```sql
CREATE INDEX "idx_note_kind" ON "note" ("kind") WHERE "archivedAt" IS NULL
```

**A partial index is only used when the query says so.** SQLite has to prove
that your query implies the index's predicate, and it has to prove it when the
query is PREPARED — before any value is bound. So the index above is used by

```js
db.note.findMany({ where: { kind: 'k3', archivedAt: null } })   // SEARCH … USING INDEX
db.note.findMany({ where: { kind: 'k3' } })                     // SCAN
```

and the second one is not a mistake — it is what asking a different question
costs. Declare the predicate you actually filter by.

**What a predicate may hold is narrowed to what can be reached**, and it is
refused at parse otherwise. Litestone binds most values in a `where`, and a
bound `?` proves nothing at prepare time — so `where: status == "pending"` would
build an index that nothing matches and every write maintains. Also refused:
`auth()`, because one index serves every caller; `now()`, which SQLite will not
have in an index predicate; and anything compiling to a subquery.

What is left is what litestone writes as literal SQL on both sides of that
comparison — the null tests and the booleans:

```lite
model Note {
  id         Int       @id
  kind       String
  email      String
  live       Boolean   @default(true)
  archivedAt DateTime?

  @@index([kind], where: archivedAt == null)
  @@index([email], where: live == true)
  @@index([kind, email], where: live == true && archivedAt == null)
}
```

On a `@@softDelete` model the declared predicate is **ANDed** with
`deletedAt IS NULL` rather than replacing it — that clause is what makes the
index reachable there at all, since every read carries it.

Two `@@index` over the same columns derive one index name whatever their
predicates differ by, and the second is refused at parse.

## select — fetch only what you need

```js
// Full row — all columns fetched
const notes = await db.note.findMany()

// Partial select — only id and kind fetched from SQLite
const slim = await db.note.findMany({ select: { id: true, kind: true } })
```

On wide tables (20+ columns), partial select can meaningfully reduce I/O.

## Indexes

```lite
model Order {
  id          Int    @id
  accountId   Int
  orderNumber Int
  status      String @default("new")

  @@index([accountId])               // single column
  @@index([accountId, status])       // composite
  @@unique([accountId, orderNumber]) // unique composite
}
```

Key index patterns:
- Always index FK columns used in `where` or `include`
- Composite indexes: most-selective column first
- `@@fts` creates its own FTS5 virtual index — no need to add `@@index` on FTS fields

## Transactions

```js
// All writes inside a transaction share one SQLite BEGIN/COMMIT
await db.$transaction(async tx => {
  await tx.order.create({ data: { accountId: 1, orderNumber: 1 } })
  await tx.order.create({ data: { accountId: 1, orderNumber: 2 } })
  // rolled back automatically on throw
})
```

Transactions use `BEGIN IMMEDIATE` — acquires write lock upfront, preventing mid-transaction deadlocks under concurrent load.

## Window functions

A `window` is inlined in the SELECT — one statement, no subquery — and a `limit`
is appended to it. SQLite computes window functions over the whole filtered set
before `LIMIT` applies, so the row numbers are right on every page:

```js
await db.order.findMany({ window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } }, limit: 5 })
// SELECT ROW_NUMBER() OVER (ORDER BY "id" ASC) AS "rn", * FROM "order" LIMIT 5
```


## $backup — hot backups

```js
import { mkdirSync } from 'node:fs'
mkdirSync('./backups', { recursive: true })

// Safe to run during writes — the backup API, or VACUUM INTO, takes a consistent snapshot
await db.$backup('./backups/prod.db')                        // → { path, size, vacuumed: false }
await db.$backup('./backups/compact.db', { vacuum: true })   // VACUUM INTO — compacted, no free pages
```

## Page size

A file database Litestone creates has 8192-byte pages. Page size is fixed at
creation and cannot be changed after: a file that already exists keeps its size,
and changing it is a `VACUUM`.

```js
const file = await createClient({ path: './schema.lite', db: './sized.db' })
const { page_size } = file.$rawDbs.main.query('PRAGMA page_size').get()
if (page_size !== 8192) throw new Error(`page_size is ${page_size}`)
```


## Doctor

```bash
litestone doctor
```

Analyzes your schema and live database for common performance issues. The PERF group runs four checks:

**FK columns missing indexes.** A `belongsTo` field declares an FK column via `@relation(fields: [authorId], references: [id])`. Without an index on `authorId`, every `findMany({ include: { posts: true }})` or filter on `authorId` scans the full child table. Postgres adds these implicitly; SQLite does not. Doctor flags every unindexed FK with the exact `@@index` directive to add.

**Tables ≥10k rows with no indexes.** The classic dev-becomes-prod cliff: a table that worked fine with 100 seed rows becomes a full-table-scan disaster at scale. Flagged so you can index the columns you actually filter on.

**Stale or missing ANALYZE stats.** `sqlite_stat1` table absent + ≥1k rows in the database = the planner has never seen statistics. Litestone runs ANALYZE after every migration, so the only way to hit this is bulk data load outside migrations. Doctor tells you the exact command to run.

**WAL pressure.** WAL file > 5000 frames means autocheckpoint is falling behind, usually because long-running readers are holding snapshots open. Surfaces a class of bugs that's hard to diagnose otherwise (queries getting slower over time as WAL bloats).

Doctor also covers schema drift, migration status, stale `-wal`/`-shm` files, and Bun version; `--ci` is the machine-readable form.
