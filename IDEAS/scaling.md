---
id: scaling
status: idea
dated: 2026-08-20
---

# Idea — Scaling a database-per-account app: what "isolated" buys and what it does not

**Status: IDEA / ANALYSIS. Nothing here is built.** Dated 2026-08-20. Written from a
question with one word doing all the work — *for a multi-tenant app where each account
gets its own database and client, are reads and writes non-blocking between accounts?*
Every claim below was read off the tree; the one defect it turned up has an id
([FJS-365](../ISSUES.md#fjs-365)).

The answer is that **"isolated" names two different things and `strategy database`
delivers exactly one of them.** That is not a shortfall — the half it delivers is the
half nothing else can — but an app sized on the wrong half is sized wrong by the
number of cores on the box.

---

## 1. Two blocking questions, two answers

**The SQLite lock is isolated and this is the real win.** Each account is a file with
its own WAL and its own writer lock (`packages/litestone/src/tenant.js`). A long write
for one account cannot make another wait, cannot produce `SQLITE_BUSY` for another,
and cannot be made slower by another's transaction. Under `strategy row` every one of
those sentences is false: one file, one writer lock, every account queued behind every
other. If contention is what is being escaped, database-per-account has already
escaped it.

**The JS thread is not isolated, and that is what the word usually means.**
`bun:sqlite` is synchronous — `packages/litestone/src/core/client.js` imports
`Database` and runs statements inline, and `policy.js` says so in a comment where the
synchronicity is load-bearing for a check. The query has finished before the `await`
in `await db.post.findMany()` yields; the promise is a wrapper around work that is
already done. So one Junction process is one thread, and every account's query is
serialised behind every other account's, along with the HTTP accept loop and the
WebSocket handlers.

| | account A blocks account B? |
| --- | --- |
| SQLite writer lock | no |
| JS event loop | **yes, for the duration of each query** |
| HTTP / WS accept loop | **yes** — same thread |

In practice most queries are microseconds and this is invisible. It stops being
invisible at an unindexed scan, a `VACUUM`, an FTS `optimize`, a migration sweep, a
large export — and at `tenants.query()`, whose `concurrency` option interleaves the
`await`s and not the CPU, so a cross-tenant aggregate is one query at a time no matter
what the number says.

**The useful framing: the file layout is a contention story, the process count is a
throughput story, and only the second one buys parallelism.**

---

## 2. Three granularities

Real concurrency means more OS processes. There are three shapes, and the middle one
is under-appreciated.

**(a) N identical instances, no routing.** Every instance opens the same tenant
directory; SQLite's WAL is multi-process safe and litestone already sets
`PRAGMA busy_timeout = 5000` on the write connection. A proxy round-robins. Cheapest
possible way to use N cores. What it does *not* give is isolation between accounts —
a slow scan still blocks whichever instance took it, and every instance's LRU pool
ends up holding every hot tenant.

**(b) Sharded — account-to-instance affinity.** The same N instances, but the proxy
routes by host or subdomain to a fixed one. The shard key is free, because
`withTenantDb` already resolves the tenant off `Host`
(`packages/junction/src/core/litestone.ts`). Two things this wins over (a): each
instance's connection pool holds only its own shard rather than the whole fleet, and
each account's file has exactly one writer *process* for its lifetime, so
cross-process `SQLITE_BUSY` stops being reachable at all. For most fleets this is the
right answer and it costs a routing rule.

**(c) A process — or a machine — per account.** Full isolation: a noisy neighbour is
impossible, per-account memory and CPU limits become expressible, a crash has a blast
radius of one, and per-account deploy, rollback and version pinning all follow. The
costs are a Bun baseline RSS per process multiplied by the account count, a port each,
a supervisor, and a control plane that places and watches processes — which is
basecamp's job description, and the reason this row belongs next to
`deploy-plane.md` rather than beside it.

**What would change the analysis** is offloading SQLite off the request thread —
worker threads with a connection each, or an async driver. Neither is proposed here:
`bun:sqlite` handles are not transferable across threads, and the shape that gets the
parallelism cheaply is (a) or (b), which need no framework change at all.

---

## 3. What the tree already does and does not support

**Junction's `start()` passes no `reusePort`.** `Bun.serve` is called at
`packages/junction/src/transport/http.ts` with `port`, `hostname`, `fetch`,
`websocket` and `error` and nothing else, so N processes cannot share one port today.
Either a proxy fronts them, or `reusePort: true` is added there and the kernel
balances. The one-line version is worth taking: it makes shape (a) free.

**Ports are derived, not chosen.** `packages/cli/core/ports.js` is the schema and
`FLI_PORT_BE` is how a spawned instance is told which one it got. A supervisor
handing out ports by hand is a second answer to a question that already has one.

**Caravan is multi-process safe and `app.scheduler` is not.** Caravan records the
owning instance on a running row and heartbeats into `job_owners`, and a cron fire is
dispatched under `cron:<job>:<epoch-minute>`, so every replica fires and only the
first queues a row ([FJS-294](../ISSUES.md)). `app.scheduler` has none of that: no
persistence, no dedupe, no principal. **Every replica runs every `app.scheduler`
timer**, so scaling out multiplies that work by N silently. Anything on it that must
happen once belongs on `app.jobs.schedule`.

**The connection pool is sized for one process and has no refcount.** `maxOpen`
defaults to 100 and `LRUPool.set` evicts the oldest entry by calling `db.$close()` on
it, with no check for whether a request still holds it. Single-threadedness keeps the
exposure narrow — only a request parked at an `await` while more than `maxOpen` *other*
accounts open can be hit — but the failure is a closed handle in the middle of a live
request. Size `maxOpen` above peak concurrent accounts, which sharding (b) makes
easier by dividing that peak by N. A refcount, or a "do not evict what is checked
out" rule, is the proper fix and is small.

**The outbox is broken under `strategy database` and is filed as
[FJS-365](../ISSUES.md#fjs-365).** `ctx.enqueue` writes its row through
`ctx.locals.db` — the tenant's file — and `deliverOutbox` reads `app.db`, which is
`createApp({ db })` and nothing else. The enqueue is accepted (the tenant file carries
the same schema, so the model is present) and the relay reports a clean pass over an
empty queue forever. This is independent of how the app is scaled; it is wrong on one
process.

---

## 4. What is actually missing

Nothing in §2 needs a framework feature. What FJS has no answer for is the layer
above: **which process serves which account, who starts it, and what happens when it
dies.** That is the same object `deploy-plane.md` describes for apps, applied one
level down to tenants, and the honest sequencing is that it is basecamp's problem
after ring 0 and ring 1 exist rather than a litestone or junction one.

The framework-side remainder is three small things, all of which pay off before any
of that: `reusePort` on the serve call, a refcount on the pool, and the
[FJS-365](../ISSUES.md#fjs-365) resolution — where the relay either sweeps the
registry's open tenants or the outbox moves to a `database` block that is not
per-tenant, and **whichever is chosen, the other shape refuses rather than no-ops.**

---

## See also

`row-level-tenancy.md` — the other strategy, and why an app might not be on this one ·
`deploy-plane.md` — placement and the control plane this analysis runs out into ·
`speed-and-footprint.md` · `packages/litestone/docs/multi-tenancy.md`
