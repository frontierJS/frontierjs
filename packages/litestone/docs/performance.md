# Performance

Litestone is designed for SQLite's single-writer, multi-reader model. Most performance work is done for you, but understanding the architecture helps when tuning.

## What to expect

Numbers from a 10k-row in-memory table on a recent Macbook (Bun 1.3, single-threaded). Treat as order-of-magnitude — your numbers will vary with disk, schema complexity, and policy/plugin overhead.

| Operation | Litestone | Raw `bun:sqlite` | Overhead |
|---|---:|---:|---:|
| `findUnique({ where: { id } })` | **2.5 µs** | 1.2 µs | ~115% |
| `findMany({})` (10k rows) | 6.1 ms | 5.6 ms | ~10% |
| `findMany({ where, limit: 10 })` | 23 µs | — | small |
| `count({ where })` (no index) | 567 µs | 496 µs | ~10% (SQLite-bound) |
| `create({ data })` | 30 µs | — | — |

Two takeaways:

- **Reading is essentially free.** On large result sets, Litestone is within 10% of raw SQLite — the cost is row hydration and that's irreducible.
- **`findUnique` is the hottest per-request operation** and Litestone optimizes it heavily. The 2.5 µs cost includes async function machinery (~370 ns), soft-delete handling, plugin-check protocol, and the prepared statement call itself. About 1.4 µs of overhead beyond raw SQLite — about as low as it gets without dropping the abstraction.

## Hot paths

Litestone precomputes prepared statements at `createClient()` for two patterns that cover most reads:

**`findMany({})` fast path.** A no-args `findMany` on a soft-delete table with no policies, no global filter, no plugins runs through a single precomputed statement. No buildSQL call, no select/include parsing. Adds the soft-delete `WHERE deletedAt IS NULL` automatically.

**`findUnique` PK fast path.** `findUnique({ where: { <pk>: value } })` — the most common per-request operation — skips the entire query builder. The statement is prepared once at table-build time and cached. Conditions: no field-level encryption, no `@@allow`/`@@deny` on this model, no global filter, no plugins, no `@from` fields.

You don't need to do anything to hit these paths — they're the default when conditions match. If you opt into a feature that disables them (e.g. add `@@allow` to a model), reads continue working through the regular path; the cost goes from ~2.5 µs to ~6 µs.

## Statement cache

Every prepared statement is cached by SQL string. Cache is per-connection, LRU-bounded (default 500 entries). On overflow, the least-recently-used statement is evicted and finalized. This matters in long-lived processes that build many distinct WHERE shapes — without the bound, the cache grows until restart.

The bound is high enough that almost no workload reaches it under normal use. If you do, raise it via `wrapDb` configuration, or restructure queries to reuse shapes (e.g. use parameterized `IN (?, ?, ?)` instead of dynamic-length lists with different sizes).

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
db.$rawDbs           // { main: Database }  — write connections
db.$walStatus        // WAL checkpoint status
```

## Read-only clients

Open a client that can only read — any attempt to write throws immediately:

```js
const db = await createClient({ path: './schema.lite', db: './app.db', readOnly: true })

await db.user.findMany()                         // ✓
await db.user.create({ data: { email: '...' } }) // ✗ throws: database is readonly
```

Useful for:
- Analytics or reporting processes that should never modify app data
- Background read jobs running alongside the main app
- Exposing a query interface without any write surface

Multiple read-only clients pointing at the same file are fine — SQLite WAL supports unlimited concurrent readers with no contention. Per-database granularity is available via `access:` if you only want some databases to be read-only:

```js
// main read-only, audit fully accessible
const db = await createClient({
  path:   './schema.lite',
  access: { main: 'readonly', audit: 'readwrite' },
})
```



Litestone pre-computes common query patterns at `makeTable` time:

**`_fastStmt`** — pre-prepared statement for the most common `findMany({})` call on soft-delete tables. Eliminates Map lookup overhead on every call. Bypassed automatically when `where`, `orderBy`, `limit`, `window`, `distinct`, hooks, or plugins are present.

**`_baseSqlWithFrom`** — pre-built SELECT string including `@from` subqueries. Reused on every query where the base SQL doesn't change.

**`_fastFindManySql`** — pre-built `SELECT * FROM "table" WHERE "deletedAt" IS NULL` for soft-delete tables without policies or filters.

## select: false

Skip `RETURNING *` and result parsing entirely on writes when you don't need the row back:

```js
// Uses writeDb.run() instead of .get() — no RETURNING clause, no row parsing
await db.order.update({ where: { id: 1 }, data: { status: 'paid' }, select: false })   // → null
await db.order.create({ data: { amount: 100 }, select: false })                          // → null
```

Most useful in hot write paths (bulk processing, event ingestion). Not available on `@@log` models — logging requires the before/after row snapshots.

## NULLS FIRST / LAST

Avoid in-memory sorting for nullable fields by pushing NULLs to a predictable position:

```js
orderBy: { deletedAt: { dir: 'asc', nulls: 'last' } }
```

Without this, SQLite's NULL ordering is arbitrary depending on index direction.

## Partial indexes

Litestone automatically creates partial indexes on `@@softDelete` models:

```sql
CREATE INDEX ... ON "users" ("accountId") WHERE "deletedAt" IS NULL
```

This means indexes only cover live rows — smaller, faster, and `WHERE deletedAt IS NULL` is always index-covered.

## select — fetch only what you need

```js
// Full row — all columns fetched
const users = await db.user.findMany()

// Partial select — only id and email fetched from SQLite
const users = await db.user.findMany({ select: { id: true, email: true } })
```

On wide tables (20+ columns), partial select can meaningfully reduce I/O.

## Indexes

```prisma
model Order {
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
  await tx.accounts.create({ data: {...} })
  await tx.users.create({ data: {...} })
  // rolled back automatically on throw
})
```

Transactions use `BEGIN IMMEDIATE` — acquires write lock upfront, preventing mid-transaction deadlocks under concurrent load.

## Window functions — inline vs subquery

When using `window` without `limit`/`offset`, Litestone inlines window functions directly in the SELECT clause:

```sql
SELECT ROW_NUMBER() OVER (...), * FROM "orders"
```

With `limit`/`offset`, it wraps in a subquery to ensure LIMIT applies after window computation:

```sql
SELECT *, ROW_NUMBER() OVER (...) FROM (SELECT * FROM "orders") _w LIMIT ?
```

For large full-table window queries (no pagination), the inline path avoids one subquery materialization.

## $backup — hot backups

```js
// Safe to run during writes — SQLite VACUUM INTO creates a consistent snapshot
await db.$backup('./backups/prod.db')
await db.$backup('./backups/compact.db', { vacuum: true })   // also compacts WAL
```

## Page size

Litestone sets `page_size = 8192` on new databases — optimal for modern SSDs. Set once at creation; cannot be changed after.

## Doctor

```bash
litestone doctor
```

Analyzes your schema and live database for common performance issues. The PERF group runs four checks:

**FK columns missing indexes.** A `belongsTo` field declares an FK column via `@relation(fields: [authorId], references: [id])`. Without an index on `authorId`, every `findMany({ include: { posts: true }})` or filter on `authorId` scans the full child table. Postgres adds these implicitly; SQLite does not. Doctor flags every unindexed FK with the exact `@@index` directive to add.

**Tables ≥10k rows with no indexes.** The classic dev-becomes-prod cliff: a table that worked fine with 100 seed rows becomes a full-table-scan disaster at scale. Flagged so you can index the columns you actually filter on.

**Stale or missing ANALYZE stats.** `sqlite_stat1` table absent + ≥1k rows in the database = the planner has never seen statistics. Litestone runs ANALYZE after every migration, so the only way to hit this is bulk data load outside migrations. Doctor tells you the exact command to run.

**WAL pressure.** WAL file > 5000 frames means autocheckpoint is falling behind, usually because long-running readers are holding snapshots open. Surfaces a class of bugs that's hard to diagnose otherwise (queries getting slower over time as WAL bloats).

Doctor also covers schema drift, migration status, encryption key configuration, stale `-wal`/`-shm` files, and Bun version. See `litestone doctor --help` for the full check list and `--ci` for machine-readable output.
