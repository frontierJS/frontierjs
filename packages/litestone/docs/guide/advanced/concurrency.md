# Concurrency

SQLite runs on the calling thread, so a call that waits or runs long blocks everything else in the process. `busyTimeout` bounds how long a write waits for another process's lock.

```lite
database audit {
  path   "./audit.db"
  driver trail
}

model User {
  id    Int    @id
  email String @unique

  @@gate(0)
}
```

```js
const db = await createClient({
  path: './schema.lite',
  databases: ':memory:',
  busyTimeout: { default: 5_000, audit: 250 },   // a request path waits little; a log waits less
})

const user = await db.user.create({ data: { email: 'a@example.com' } })
if (user.id !== 1) throw new Error('expected the write to land')

let refused = false
try {
  await createClient({ path: './schema.lite', databases: ':memory:', busyTimeout: { nowhere: 10 } })
} catch (e) {
  if (!/nowhere/.test(e.message)) throw e
  refused = true
}
if (!refused) throw new Error('a busyTimeout key naming no database should be refused')
```

The default is five seconds. `LITESTONE_BUSY_TIMEOUT` sets it for a process that builds no client, such as a migration.

## What else it can do

- `busyTimeout: 0` fails at once, for a fire-and-forget write
- The timeout is per process by design, so there is no `database { }` spelling for it
- Two connections to one file in one process cannot wait for each other, so keep one client per file
- A worker thread or a separate process moves a slow query off the event loop
- `announce crossProcess` on a database block tells other processes' `$tapEvents` about a write
- `scope` with `@@exclude` refuses two rows that overlap in time for one key, graded under the write lock
- WAL lets readers and a writer run together, and transactions take the write lock up front
- `synchronous = NORMAL` loses nothing to a crash, and replication bounds the loss to a power cut

**In depth:** [Concurrency § Waiting for another process](../../concurrency.md#waiting-for-another-process), [§ Waiting for yourself deadlocks](../../concurrency.md#waiting-for-yourself-deadlocks), [§ When the query itself is slow](../../concurrency.md#when-the-query-itself-is-slow), [§ No two may overlap](../../concurrency.md#no-two-may-overlap--scope-and-exclude), [§ WAL](../../concurrency.md#wal-and-what-it-does-not-fix)
