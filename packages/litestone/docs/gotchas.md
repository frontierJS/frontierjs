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

**SQLite's own clock does not match what is stored, and `datetime('now')` is
refused because of it.** It answers `2026-08-13 07:38:31` — space separator, no
milliseconds, no zone — while the column holds `2026-08-13T07:38:31.984Z`. The
comparison is string-wise and `'T'` (0x54) sorts above a space (0x20), so every
row stored TODAY compares greater than a same-day `datetime('now')`: the
predicate is right for yesterday's rows and wrong for this morning's, and
nothing is raised. A demo seeded with last week's data passes.

`now()` is the spelling that matches. Its modifiers are bound as parameters:

```js
import { sql, now } from '@frontierjs/litestone'

// Rows created in the last 7 days
db.order.findMany({
  where: { $raw: sql`createdAt >= ${now('-7 days')}` }
})

// Rows where a deadline has passed
db.task.findMany({
  where: { $raw: sql`dueAt < ${now()}` }
})
```

`julianday()` needs no help — it answers a number, so
`julianday('now') - julianday(createdAt) > 30` compares like with like.

`@date` fields are stored as `YYYY-MM-DD` strings. Same applies.

---

## Concurrent deploys sharing a WAL file can cause write contention

Blue-green deployments where two app instances overlap and share the same SQLite file can cause WAL contention under write load. Both containers open write connections; only one can hold the write lock at a time. Under high write rates, the losing container's writes queue up or timeout.

Mitigations:
- Use a `busy_timeout` pragma — Litestone sets this automatically on every
  connection it opens (5000ms default, `src/core/pragmas.js`), and this is where
  raising it is right: `createClient({ busyTimeout: 15_000 })`, or
  `LITESTONE_BUSY_TIMEOUT=15000` for a process that builds no client
- Use Litestream WAL replication — only the primary writes, replicas read from S3
- Stagger deploys: drain old container before starting new one
- Keep write rates low (most web apps have far more reads than writes)

**`busy_timeout` is a CROSS-PROCESS device and is no help inside one.**
`bun:sqlite` is synchronous, so a connection waiting on the write lock blocks
the thread it is on — which in a single process is the event loop. Two things
follow, and the second is worse than the first:

- A five-second wait is five seconds of a server answering nobody.
- It can **deadlock outright**. The waiter blocks the loop, so the holder's own
  continuation never runs to commit, so the wait can only ever expire. Measured:
  a second client waited the full 5000ms for a lock held for 800ms, because the
  holder's release was a `setTimeout` that could not fire. Two real processes,
  same 800ms hold — waited it out and committed.

So the timeout is worth having for the case it is for (another API, a job
runner, `fli tinker`, a migration) and is not a substitute for not contending.
Within one client `$transaction` takes a FIFO lock, so two transactions queue in
JavaScript and never reach the SQLite lock at all — which is why the in-process
case is normally fine without any of this. **One client per database file per
process** is what keeps it that way; two `createClient` calls on one path are two
connections that can deadlock, where `$setAuth`/`asSystem`/`$scopedBy` are views
over one handle and are free.

[concurrency.md](concurrency.md) is the whole of it, including how to pick a
number and what to do when the query itself is the slow part.

---

## kamal app exec adds ~500MB RAM per invocation

Running `litestone studio` or any command via `kamal app exec` spins up a new Docker container. Each container adds ~500MB RAM overhead (Docker + runtime). On a 1GB VPS this can OOM.

Run Studio directly on the host instead:

```bash
ssh myserver
cd /app && litestone studio --port=8502
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

---

## ~~@encrypted on a Json field silently destroys the value~~ — fixed 2026-08-06

**Fixed.** `Json @encrypted` now round-trips. Kept here because the failure shape
is worth recognizing and because a database written before the fix still holds
the damage.

It used to store the string `"[object Object]"`: the value reached the cipher
through `String(obj)` rather than `JSON.stringify`, so the payload was gone
*before* encryption happened. Everything around it worked, which is what made it
dangerous — the column really was encrypted at rest, `@guarded(all)` was
enforced, the write returned normally, nothing threw and nothing warned. Only the
value was missing, and only on read-back.

A Json field is now serialized before encryption and parsed after decryption,
keyed on the declared type. `@secret`, `$rotateKey` and
`@encrypted(deterministic: true)` all work on a Json field. `@hashed` does not —
it requires a `String` column, because a digest is text and nothing parses back
out of it.

**Rows written before the fix are not recoverable** — the original never reached
the cipher. They decrypt to the literal string `'[object Object]'` rather than
`null`, deliberately: `null` reads as "this was empty", the string reads as
"something went wrong here", and only the second sends anyone looking. Search for
it if you ran `Json @encrypted` in anger:

```sql
-- per @encrypted Json column
SELECT id FROM vault WHERE blob IS NOT NULL;   -- then read each back through the client
```

## Audit log reads lag writes within a session

The logger driver buffers and flushes on a **~1s timer and on process exit**. Immediately after a write, `auditLogs.findMany()` returns 0 rows and the `.jsonl` file may not exist yet — the next process sees everything. Measured on a fresh database: 1 write → 0 rows, no file; +2s → 1 row; +50 more writes in the same process → still 1 row; next process → 51 rows.

**Nothing is lost.** This is visibility lag, not data loss, and it is why reading the trail immediately after writing (as several examples do) reports an empty log.

Related: every relative `database { path }` — the logger's included — resolves against the **process CWD** by default, so where the trail lands depends on where you launch from. `createClient({ path, resolveFrom: 'schema' })` anchors it to the app root instead, and a schema assembled in memory says where it would have lived: pass the file as `path:` beside the string, or a directory as `resolveFrom`. Litestone says so when it CREATES a directory for a database — the one signal every instance of `FJS-449` had in common. See § *Where a relative database path lands*.

## Where a relative `database { path }` lands

Against the **process CWD**, by default. So the same schema means a different
file depending on which directory the command was typed in, and nothing fails
when it goes wrong: SQLite creates the file, litestone creates the directory
above it, and every tool then reports on the new empty database. Measured
(`FJS-449`): `litestone studio` run from `db/` served `db/db/shop.db` — 4,096
bytes, one empty header page — for nineteen hours, while the real database sat
two directories up; and a `vite build` run from a surface root prerendered
twelve product pages as **zero products, exit 0**, which is a published static
site with nothing in it.

Three ways to say otherwise, and they are for different shapes:

| | |
| --- | --- |
| `createClient({ path, resolveFrom: 'schema' })` | anchors to the APP ROOT — the schema file's directory, or its parent when that directory is `db`. This is what the litestone CLI does at every call site, which is why a command is safe from any directory. |
| `createClient({ schema, path, resolveFrom: 'schema' })` | an app that reads `db/schema.lite` and appends fragments to it — auth's models, the outbox — still has the file. Name it. The string is parsed; the path is the anchor. |
| `createClient({ schema, resolveFrom: '<dir>' })` | a schema with no file behind it at all. A directory or a `file:` URL — `new URL('../..', import.meta.url)`. It is a statement: an anchor that is not a directory throws rather than falling back. |

`createTenantRegistry` takes `path` the same way, and it matters twice over —
the `tenancy { dir }` and `tenancy { registry }` paths are written against the
**schema file's own directory**, not the app root, which is the one place the
two bases differ.

An override is not affected and must not be: `createClient({ db })` and
`databases: { name: { path } }` come from code, and code is written against the
process.

**The default stays the CWD.** Isolation-by-CWD is a real contract — a seed test
that runs in a scratch directory redirects a database that has no env var by the
working directory alone — so anchoring is opted into, not applied.

**And a mint is announced.** Creating the database FILE is ordinary; every first
run does it. Creating the DIRECTORY it sits in is the signal, and it is what
every measured instance of this had in common:

```
[litestone] Created /app/site/db for a database that was not there.
            path: /app/site/db/shop.db
            cwd:  /app/site
```

The cwd is in the message because the resolved path alone does not say what went
wrong: `db/shop.db` from the app root and from a surface root print the same
relative string and name different files.
