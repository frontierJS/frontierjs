# Concurrency

`bun:sqlite` is **synchronous**. Every query blocks the thread that issued it —
there is no pool, no round trip, and no `await` that yields while SQLite works.
Litestone's methods are `async`, but that is about hooks, policies and the
transaction lock; the SQL itself runs to completion inside one tick.

That is mostly why it is fast. A query that would cost a network hop to Postgres
costs a function call here, and the whole class of pool exhaustion, connection
leaks and *too many clients already* does not exist. The trade is that a call
which takes a long time takes it out of everything else in the process.

This page is the practical half: which calls can be long, what to do about each,
and where the knob is.

---

## The rule underneath everything

**A SQLite call blocks its thread for as long as it runs.** In a single-process
server that thread is the event loop, so it blocks every other request too.

Three things make a call long, and they have different answers:

| Why it is long | Answer |
| --- | --- |
| Waiting for a write lock another **process** holds | `busyTimeout` — bound it, below |
| Waiting for a write lock **this process** holds | Never wait. Below — it deadlocks |
| The query itself is slow (a big scan, an aggregate, `VACUUM`) | Make it fast, or move it off the loop |

An ordinary indexed read is tens of microseconds and none of this applies to it.

---

## Waiting for another process

SQLite serialises writers with a file lock. A connection that finds it held
either waits or fails at once with `SQLITE_BUSY`, and `busy_timeout` is which.
**SQLite's default is zero** — fail at once — which is almost never what an app
wants, so litestone sets a floor on every connection it opens.

Measured, one connection holding the write lock and a second trying to write:

| | |
| --- | --- |
| No timeout | fails in **1ms** |
| Timeout, holder never releases | waits **5007ms**, then fails |
| Timeout, holder commits after 1.5s | waits **1444ms**, then commits |

The last row is the point. This is a **cross-process device**: the holder is
making progress on its own, so there is something to wait for.

### The knob

```js
const db = await createClient({
  path: './db/schema.lite',
  busyTimeout: 15_000,          // ms; 0 means fail immediately
})
```

Per database, when one of them wants a different answer:

```js
busyTimeout: { default: 5_000, audit: 250 }
```

For a process that constructs no client — the CLI, a migration, a worker started
by a supervisor:

```
LITESTONE_BUSY_TIMEOUT=30000 bunx litestone migrate apply
```

**Precedence is option → env → default (5000).** A malformed value is refused by
name at `createClient`, and so is a key naming a database the schema does not
declare — a dropped key is a database silently keeping the default, which is the
kind of silence this whole area is full of.

Litestone applies the same number to every connection it opens: main's write and
read handles, the tenant registry and each tenant's file, the CLI's handles, and
the companion index beside a `jsonl`/`logger` file.

`@frontierjs/caravan` (`createCaravan({ busyTimeout })`) and Junction's SQLite
cache (`createSqliteCache({ busyTimeout })`) have their own, because they own
their own connections. Junction's `createDatabase` takes `pragmas: [...]`, which
runs after the defaults and therefore overrides it.

### There is deliberately no `database { }` spelling

`FJS-D155`. How long to wait for another process is a fact about **this**
process, and the same `schema.lite` is opened by an API answering a person —
which cannot afford to wait — and by a queue draining a batch, which can. A
declaration is one answer to a question that differs by who is asking. Same
reason a relative `database { path }` resolves against the working directory:
code is written against the process.

### Picking a number

It is a bound on how long **one call can block this process**. So:

- **A request path**: low. 5000 means a request can sit for five seconds; two
  such requests and the process is not answering anybody. If contention here is
  routine, the fix is not a bigger number.
- **A job worker in its own process**: high. It has nobody to keep waiting, and
  giving up means a retry that contends again.
- **A migration or a CLI command against a live database**: high, via the env
  var. It runs once and losing to a busy app is worse than waiting.
- **A fire-and-forget write** (an audit row): low or `0`. Its failure is
  swallowed by design, so blocking the loop to place a row nobody awaits is the
  wrong trade — `{ audit: 250 }`.

---

## Waiting for yourself deadlocks

Two connections to one file **in one process** cannot wait for each other.
Twelve lines, measured:

```js
const a = new Database(path); a.run('PRAGMA journal_mode = WAL')
const b = new Database(path); b.run('PRAGMA busy_timeout = 2000')

a.run('BEGIN IMMEDIATE')
setTimeout(() => a.run('COMMIT'), 200)   // will not get a turn

b.run("INSERT INTO t VALUES ('b')")      // blocks the loop for the full 2000ms
```

```
b threw SQLITE_BUSY after 2004 ms — the holder's 200ms timer never got a turn
holder committed
```

`b` blocks the thread, so the timer that would release `a` cannot run, so the
wait can only ever expire. A larger timeout makes it strictly worse.

**What keeps this from happening in litestone** is that `$transaction` takes a
FIFO lock per client, in JavaScript, before it touches SQLite. Two transactions
on one client queue in the promise chain and never contend for the file lock.

**What you have to do** is not defeat it:

- **One client per database file per process.** `createClient` twice on one path
  is two connections that can deadlock. `db.$setAuth(u)`, `db.asSystem()` and
  `db.$scopedBy(...)` are all views over the same handles — those are free.
- **Under `strategy database`**, each tenant is its own file, so tenants never
  contend with each other. The registry and any `jsonl`/`logger` database are
  shared, and those are the ones to watch.
- **Do not `await` something slow inside `$transaction`.** The lock is held for
  the whole callback, so an HTTP call or a mail send inside one stalls every
  other transaction in the process — and the write lock is held on disk the
  whole time, which stalls every other *process* too. In a Junction service the
  answers are `ctx.afterCommit(fn)` for an effect that must happen once after
  the commit, and `ctx.enqueue(job, payload)` for one that must survive a crash.

---

## When the query itself is slow

The timeout has nothing to say here — nothing is contended, the work is just
long. Options, cheapest first:

1. **Make it not slow.** An index, a narrower `select`, `select: false` on a
   write that does not need the row back. See [performance.md](performance.md).
2. **Bound it.** A report over the whole table is a different feature from a
   screen: paginate it, or precompute it on a schedule.
3. **Move it off the loop.** Two ways, and they are the same mechanism from
   SQLite's point of view.

### Another process

A job worker, run as its own process against the same file. It contends the way
any second process does, which is what `busyTimeout` is for. This is the default
answer, and it is why `@frontierjs/caravan`'s queue is a database rather than an
in-memory list — though note that `app.jobs` workers run **in the API's own
process** unless you start a separate one, so a long handler blocks the API.

**A second process announces nothing to the first unless the database says so.**
`$tapEvents` is a callback list on one client, so a worker's writes reached a
serving process's subscribers never — every live list, `record(id)` and `changed`
reload stale with nothing marking it (`FJS-642`). Declare it:

```prisma
database main {
  path     "./db/app.db"
  announce crossProcess     // default: inProcess
}
```

Each announced write then records a row in the database, and every other process
on this machine reads it and hands it to its own `$tapEvents` subscribers — the
same seam, so nothing above Litestone can tell a foreign event from a local one.
It costs about **+14 µs on a single-row write** and nothing on a bulk one, which
is why it is declared rather than default.

Three things it does not promise, all stated rather than approximated:

- **One machine.** Two processes share a file; a second machine shares nothing
  and hears nothing.
- **At-most-once across a crash.** The row is recorded after the write's own
  transaction commits, so a process that dies in the microseconds between them
  loses that one announcement — the same trade Junction's `ctx.afterCommit`
  makes, for the same reason.
- **The row arrives as it is NOW.** The table carries the id, never the row, so
  the receiving process re-reads it — which is what keeps the plaintext of an
  `@encrypted` column out of a table beside the ciphertext, and what makes the
  row the shape that process's own reads produce.

### A worker thread

`node:worker_threads` works with `bun:sqlite`, and a worker is a second thread of
execution, so it has the property that matters: it makes progress while the main
thread is blocked, and vice versa. Measured — the main loop kept ticking (56
ticks over 10ms intervals) through a 600ms hold taken inside a worker, and a main
thread waiting on a lock a *worker* held waited 639ms and committed, where the
same shape on one thread deadlocks:

```js
import { Worker } from 'node:worker_threads'
const w = new Worker('./report-worker.js', { workerData: { path } })
```

Open a connection inside the worker (a `Database` handle cannot be transferred),
give it the same `busy_timeout`, and treat it as a separate process in every
respect — including that it cannot see the parent's transaction.

Worth it for a genuinely CPU-or-IO-heavy read: a large export, an FTS rebuild, a
report. Not worth it for ordinary queries, where the handoff costs more than the
query.

---

## WAL, and what it does not fix

Litestone opens main in WAL mode. WAL means **readers do not block writers and
writers do not block readers** — a read connection can serve while a write
transaction is open. It does *not* mean writers do not block writers: SQLite has
one writer at a time, and that is the lock everything above is about.

Litestone also uses `BEGIN IMMEDIATE` rather than a deferred `BEGIN`, so a
transaction takes the write lock up front. A deferred begin upgrades to a write
lock partway through, which surfaces as `SQLITE_BUSY` on a statement in the
middle of a transaction that had already done work.

Two things reach across the WAL guarantee, which is why the read connection is
given the timeout too: a checkpoint, and recovery after a writer crashed.

---

## Quick reference

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SQLITE_BUSY` in ~1ms | a connection with no timeout | it should be one litestone opened — file it |
| `SQLITE_BUSY` after exactly the timeout, from one process | two clients on one file in one process | one client per file |
| Requests stall in bursts | a long transaction, probably awaiting something | `ctx.afterCommit` / `ctx.enqueue` |
| Requests stall while a job runs | a worker in the API's process | run the worker separately |
| A migration loses to a live app | the CLI's default wait | `LITESTONE_BUSY_TIMEOUT=30000` |
| Audit rows go missing under load | the log index lost the lock | it warns once per model; lower `{ audit: N }` or raise it |

Background: `FJS-569`, `FJS-D155`, and `src/core/pragmas.js`.
