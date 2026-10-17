# Gotchas

Production surprises and things that behave differently than you'd expect.
Every one of them is measured; the examples on this page use this schema:

```lite
model User {
  id        Int       @id @default(autoincrement())
  name      String
  bio       String?
  status    String?
  active    Boolean   @default(true)
  deletedAt DateTime?

  @@softDelete
}

model Event { id Int @id  meta Json }
model Order { id Int @id  createdAt DateTime @default(now()) }
model Task  { id Int @id  dueAt DateTime }
```

---

## SQLite has no ILIKE, and `lower()` folds ASCII only

SQLite's `LIKE` is case-insensitive for ASCII letters only — `smith` matches
`Smith`, and `émile` does not match `Émile`. `lower()` has the same reach:
`lower('ÉMILE')` is `'Émile'`. Neither folds a non-ASCII letter unless SQLite
was built with ICU, and `bun:sqlite`'s is not.

`contains`, `startsWith` and `endsWith` compile to a plain `LIKE` with the
pattern bound as a parameter — `"name" LIKE ? ESCAPE '\'` — so they inherit
exactly that: case-insensitive for ASCII, case-sensitive past it. Nothing
wraps the column in `lower()`:

```js
await db.user.create({ data: { name: 'Smith' } })
await db.user.create({ data: { name: 'Émile' } })

const ascii = await db.user.findMany({ where: { name: { contains: 'smith' } } })
// SELECT * FROM "user" WHERE ("deletedAt" IS NULL AND "name" LIKE ? ESCAPE '\')  — ['%smith%']
const accented = await db.user.findMany({ where: { name: { contains: 'émile' } } })
if (ascii.length !== 1 || accented.length !== 0) throw new Error(`${ascii.length} ${accented.length}`)
```

A `$raw` `LIKE` behaves the same, and `LOWER()` around it changes nothing for
`É`. To search accented text case-insensitively, fold it in JavaScript before
it is stored — a second column written with `@lower`, or
`normalize('NFD')` plus a diacritics strip — and search that column.

---

## json_extract returns native types — cast before comparing to strings

`json_extract(data, '$.id')` returns an `INTEGER` if the value is a number. Comparing it to a string silently fails (returns no rows, no error):

```js
await db.event.create({ data: { id: 1, meta: { userId: 123 } } })

// This silently returns nothing — json_extract returns integer, not string
const asText = await db.event.findMany({
  where: { $raw: sql`json_extract(meta, '$.userId') = ${'123'}` }
})

// Correct — cast to TEXT first
const cast = await db.event.findMany({
  where: { $raw: sql`CAST(json_extract(meta, '$.userId') AS TEXT) = ${'123'}` }
})

// Or compare to integer directly
const asInt = await db.event.findMany({
  where: { $raw: sql`json_extract(meta, '$.userId') = ${123}` }
})
if (asText.length !== 0 || cast.length !== 1 || asInt.length !== 1) throw new Error('json_extract affinity changed')
```

---

## A lone `Int @id` is AUTOINCREMENT, and a gap is normal

Litestone emits `"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT` for a lone
`Int @id`, with or without `@default(autoincrement())` (`FJS-D887`). Three
things follow:

- **A deleted row's id is retired.** The next id is one past the highest id
  the table ever held, so a permalink never comes to mean another row.
- **A gap is normal.** An `upsertMany` row that lands on the conflict branch
  spends an id. Never count rows by the highest id; the row count is
  `db.user.count()`.
- **`sqlite_sequence` exists** in the database, one row per such table.
  `introspect` skips it. A composite key and a `String @id` take no
  `AUTOINCREMENT`.

```js
const a = await db.user.create({ data: { name: 'a' } })
await db.user.delete({ where: { id: a.id } })       // a hard delete; remove() would keep the row
const b = await db.user.create({ data: { name: 'b' } })
if (b.id <= a.id) throw new Error(`expected a new id, got ${b.id} after ${a.id}`)
```

A key that must be unique across databases, or must not be guessable, is
still `String @id @default(uuid())`.

---

## notIn includes NULL rows

SQLite's `NOT IN` does not match `NULL` values — which is mathematically correct but surprises most developers. Litestone's `notIn` operator matches the developer expectation and **does** include `NULL` rows, by compiling to `("status" NOT IN (?) OR "status" IS NULL)`:

```js
await db.user.create({ data: { name: 'a', status: 'admin' } })
await db.user.create({ data: { name: 'b', status: null } })
await db.user.create({ data: { name: 'c', status: 'member' } })

// Returns users where status is NOT 'admin' — including users where status IS NULL
const rows = await db.user.findMany({ where: { status: { notIn: ['admin'] } } })
if (rows.map(r => r.name).join() !== 'b,c') throw new Error(rows.map(r => r.name).join())
```

If you need to exclude NULLs too:

```js
await db.user.create({ data: { name: 'a', status: 'admin' } })
await db.user.create({ data: { name: 'b', status: null } })
await db.user.create({ data: { name: 'c', status: 'member' } })

const rows = await db.user.findMany({
  where: {
    status: { notIn: ['admin'] },
    AND: [{ status: { not: null } }]
  }
})
if (rows.map(r => r.name).join() !== 'c') throw new Error(rows.map(r => r.name).join())
```

---

## Boolean is stored as 0/1 — coercion is automatic

SQLite has no native Boolean type. Litestone stores `true` as `1` and `false` as `0`, and coerces on read. This is transparent in normal ORM usage. In raw SQL a `true` bound as a parameter is bound as `1`, and the keyword `true` in SQL text is `1` too, so both spellings below match; what never matches is the string `'true'`:

```js
await db.user.create({ data: { name: 'a', active: true } })
await db.user.create({ data: { name: 'b', active: false } })

const one  = await db.user.findMany({ where: { $raw: sql`active = ${1}` } })
const bool = await db.user.findMany({ where: { $raw: sql`active = ${true}` } })
const text = await db.user.findMany({ where: { $raw: sql`active = ${'true'}` } })
if (one.length !== 1 || bool.length !== 1 || text.length !== 0) throw new Error(`${one.length} ${bool.length} ${text.length}`)
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

await db.order.create({ data: { id: 1 } })
await db.task.create({ data: { id: 1, dueAt: '2020-01-01T00:00:00.000Z' } })

// Rows created in the last 7 days
const recent = await db.order.findMany({
  where: { $raw: sql`createdAt >= ${now('-7 days')}` }
})

// Rows where a deadline has passed
const overdue = await db.task.findMany({
  where: { $raw: sql`dueAt < ${now()}` }
})
if (recent.length !== 1 || overdue.length !== 1) throw new Error(`${recent.length} ${overdue.length}`)
```

```js throws
await db.task.findMany({ where: { $raw: sql`dueAt < datetime('now')` } })
// raw SQL: `datetime('now')` cannot match a stored DateTime.
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
runner, `fli db:repl`, a migration) and is not a substitute for not contending.
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

Run Litestone Studio directly on the host instead:

```bash
ssh myserver
cd /app && litestone studio --port=5502
```

---

## select: false still reads the row on @@trail models

`select: false` skips `RETURNING *` for maximum write performance, and the
call answers `null`. On models with `@@trail` or fields with `@trail`,
Litestone needs the before/after row images for the audit entry, so the row
is read anyway and the images are recorded; the caller still gets `null`. The
audit entry is more important than the write speed optimization.

---

## Soft delete and findUnique

`findUnique` applies the soft-delete filter by default — it will return `null` for soft-deleted rows even if you know the ID. Use `withDeleted: true` to find them. Note which verb soft-deletes: `remove()` stamps `deletedAt`, `delete()` is the hard delete regardless of `@@softDelete`:

```js
const u = await db.user.create({ data: { name: 'a' } })
await db.user.remove({ where: { id: u.id } })

const hidden = await db.user.findUnique({ where: { id: u.id } })                      // → null
const found  = await db.user.findUnique({ where: { id: u.id }, withDeleted: true })   // → the row
if (hidden !== null || found?.name !== 'a') throw new Error('soft-delete filter changed')
```

---

## @sequence rolls back with its transaction

`@sequence` fields take their next value from `_litestone_sequences`, a table in
the same database as the row. The counter moves inside the write's own
transaction, so a rollback takes it back and the next successful create reuses
the number — unlike a PostgreSQL sequence, which runs outside transactions and
leaves a gap:

```lite
model Ticket {
  id     Int @id @default(autoincrement())
  orgId  Int
  number Int @sequence(scope: orgId)
}
```

```js
try {
  await db.$transaction(async tx => {
    await tx.ticket.create({ data: { orgId: 1 } })
    throw new Error('abandon')
  })
} catch {}

const t = await db.ticket.create({ data: { orgId: 1 } })
if (t.number !== 1) throw new Error(`expected 1 after a rollback, got ${t.number}`)
```

What does leave a gap is a delete: the counter never moves backwards for a row
that was committed and then removed.

---

## `Json @encrypted` round-trips, and a database written before it did holds `'[object Object]'`

A Json field is serialized before encryption and parsed after decryption,
keyed on the declared type. `@secret`, `$rotateKey` and
`@encrypted(deterministic: true)` all work on a Json field. `@hashed` does not —
it requires a `String` column, because a digest is text and nothing parses back
out of it.

The failure shape is worth recognizing because an older database may still hold
it: the value once reached the cipher through `String(obj)` rather than
`JSON.stringify`, so the payload was gone *before* encryption happened.
Everything around it worked — the column really was encrypted at rest,
`@guarded` was enforced, the write returned normally, nothing threw and nothing
warned. Only the value was missing, and only on read-back.

**Those rows are not recoverable** — the original never reached the cipher.
They decrypt to the literal string `'[object Object]'` rather than `null`:
`null` reads as "this was empty", the string reads as "something went wrong
here", and only the second sends anyone looking. Search for it if you ran
`Json @encrypted` on an early build:

```sql
-- per @encrypted Json column
SELECT id FROM vault WHERE blob IS NOT NULL;   -- then read each back through the client
```

## Audit log reads lag writes within a session

The trail **defers one event-loop tick**: `fireLog()` schedules with `setImmediate`, so a read in the same tick as the write returns 0 rows and the `.jsonl` file may not exist yet. Yield once — `await new Promise(r => setImmediate(r))` — and every entry is there. There is no timed buffer to wait out.

**Nothing is lost.** This is visibility lag, not data loss, and it is why reading the trail on the line after a write reports an empty log.

Related: every relative `database { path }` — the trail's included — resolves against the **process CWD** by default, so where the trail lands depends on where you launch from. `createClient({ path, resolveFrom: 'schema' })` anchors it to the app root instead, and a schema assembled in memory says where it would have lived: pass the file as `path:` beside the string, or a directory as `resolveFrom`. Litestone says so when it CREATES a directory for a database — the one signal every instance of `FJS-449` had in common. See § *Where a relative database path lands*.

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
