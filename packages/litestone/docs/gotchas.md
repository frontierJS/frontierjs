# Gotchas

Production surprises and things that behave differently than you'd expect.

---

## SQLite has no ILIKE

SQLite's `LIKE` is case-insensitive for ASCII letters only — it works for `a-z`. For anything else (Unicode, accented characters), use `LOWER()`:

```js
// This works for ASCII
db.user.findMany({ where: { name: { contains: 'smith' } } })
// Litestone compiles this to: WHERE LOWER("name") LIKE '%smith%'

// For $raw with LIKE — always LOWER() explicitly
db.user.findMany({
  where: { $raw: sql`LOWER(bio) LIKE ${'%' + term.toLowerCase() + '%'}` }
})
```

There is no `ILIKE` in SQLite. Litestone's `contains`, `startsWith`, `endsWith` operators automatically use `LOWER()`. Raw SQL predicates using `LIKE` directly will be case-sensitive for non-ASCII.

---

## json_extract returns native types — cast before comparing to strings

`json_extract(data, '$.id')` returns an `INTEGER` if the value is a number. Comparing it to a string silently fails (returns no rows, no error):

```js
// This silently returns nothing — json_extract returns integer, not string
db.events.findMany({
  where: { $raw: sql`json_extract(meta, '$.userId') = ${'123'}` }
})

// Correct — cast to TEXT first
db.events.findMany({
  where: { $raw: sql`CAST(json_extract(meta, '$.userId') AS TEXT) = ${'123'}` }
})

// Or compare to integer directly
db.events.findMany({
  where: { $raw: sql`json_extract(meta, '$.userId') = ${123}` }
})
```

---

## sqlite_sequence shows total rows ever created, not current count

`sqlite_sequence` is SQLite's auto-increment counter table. It tracks the highest ID ever assigned — not the current row count. After deleting rows and restarting, the counter keeps going from where it left off:

```sql
SELECT seq FROM sqlite_sequence WHERE name = 'users';
-- → 847   (even if you only have 3 users currently)
```

Use `SELECT COUNT(*) FROM users` for the actual row count. Use `db.user.count()` in Litestone.

---

## notIn includes NULL rows

SQLite's `NOT IN` does not match `NULL` values — which is mathematically correct but surprises most developers. Litestone's `notIn` operator matches the developer expectation and **does** include `NULL` rows:

```js
// Returns users where status is NOT 'admin' — including users where status IS NULL
db.user.findMany({ where: { status: { notIn: ['admin'] } } })
```

If you need to exclude NULLs too:

```js
db.user.findMany({
  where: {
    status: { notIn: ['admin'] },
    AND: [{ status: { not: null } }]
  }
})
```

---

## Boolean is stored as 0/1 — coercion is automatic

SQLite has no native Boolean type. Litestone stores `true` as `1` and `false` as `0`, and coerces on read. This is transparent in normal ORM usage, but matters in raw SQL:

```js
// In raw SQL, compare to 0/1, not true/false
db.user.findMany({
  where: { $raw: sql`active = ${1}` }    // correct
})
db.user.findMany({
  where: { $raw: sql`active = ${true}` } // might not work depending on driver
})
```

---

## DateTime is stored as ISO-8601 text — comparison works, arithmetic needs care

Litestone stores `DateTime` as ISO-8601 strings (`2024-01-15T10:30:00.000Z`). ISO-8601 strings are lexicographically sortable, so `ORDER BY createdAt` and range queries like `{ gte: '2024-01-01' }` work correctly.

Date arithmetic in raw SQL requires SQLite's date functions:

```js
// Rows created in the last 7 days
db.order.findMany({
  where: { $raw: sql`createdAt >= datetime('now', '-7 days')` }
})

// Rows where a deadline has passed
db.task.findMany({
  where: { $raw: sql`dueAt < datetime('now')` }
})
```

`@date` fields are stored as `YYYY-MM-DD` strings. Same applies.

---

## Concurrent deploys sharing a WAL file can cause write contention

Blue-green deployments where two app instances overlap and share the same SQLite file can cause WAL contention under write load. Both containers open write connections; only one can hold the write lock at a time. Under high write rates, the losing container's writes queue up or timeout.

Mitigations:
- Use a `busy_timeout` pragma (Litestone sets this automatically: 5000ms)
- Use Litestream WAL replication — only the primary writes, replicas read from S3
- Stagger deploys: drain old container before starting new one
- Keep write rates low (most web apps have far more reads than writes)

---

## kamal app exec adds ~500MB RAM per invocation

Running `litestone studio` or any command via `kamal app exec` spins up a new Docker container. Each container adds ~500MB RAM overhead (Docker + runtime). On a 1GB VPS this can OOM.

Run Studio directly on the host instead:

```bash
ssh myserver
cd /app && litestone studio --port=5001
```

---

## select: false is silently ignored on @@log models

`select: false` skips `RETURNING *` for maximum write performance. On models with `@@log` or fields with `@log`, Litestone needs the before/after row snapshot for the audit entry. On these models, `select: false` is silently ignored and the full `RETURNING` path runs. This is intentional — the audit entry is more important than the write speed optimization.

---

## Soft delete and findUnique

`findUnique` applies the soft-delete filter by default — it will return `null` for soft-deleted rows even if you know the ID. Use `withDeleted: true` to find them:

```js
await db.user.findUnique({ where: { id: 1 } })              // → null if soft-deleted
await db.user.findUnique({ where: { id: 1 }, withDeleted: true }) // → the row
```

---

## @sequence gaps on rollback

`@sequence` fields use `_litestone_sequences` to track per-scope counters. The counter increments when the row is created. If the transaction rolls back, the counter does not roll back — the sequence will have a gap. This is standard behavior for sequences (same as PostgreSQL sequences) and is intentional. Sequence values are monotonically increasing but not guaranteed to be gap-free.
