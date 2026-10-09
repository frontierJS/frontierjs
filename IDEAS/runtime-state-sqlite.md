---
id: runtime-state-sqlite
status: proposed
dated: 2026-09-15
---

# Idea — Runtime state as tables: the operational half the seed does not reach

**Status: PROPOSED.** Dated 2026-09-15. Probed against the tree rather than
recalled; every claim about what exists names the file it was read from.

Brought in from
[*Representing application state using SQLite*](https://world.hey.com/apetrov/representing-application-state-using-sqlite-b9875b47)
(A. Petrov), which argues for an in-memory SQLite database as the single home for
a server's own state instead of a scatter of maps, arrays and hand-built indexes.
**Three of its four claims are already FJS doctrine** and are recorded here only
so nobody imports them a second time: the state model belongs in DDL (that is the
seed), state should be inspectable with ordinary SQL rather than a debugger
(`fli tinker`, db studio), and SQLite makes a good durable buffer for outgoing
events (the transactional outbox, and caravan's `jobs.db`). The framework does
not need to be persuaded of any of them.

**What does not yet hold here is the fourth**: the article applies all three to
the server's OWN state, and FJS applies them to the application's data only. The
seed reaches every row an app owns and reaches nothing about the process serving
it.

---

## What is already true

Half of this has arrived without being named as a policy.

- Junction's cache is an in-memory SQLite database already — `new Database(opts.path ?? ':memory:')`
  in `packages/junction/src/cache/index.ts`. It is the existing proof that the
  shape is affordable on a request path here.
- Caravan's queue, its cron rows, its instance heartbeats and the running-row
  ownership are all real tables in `./db/jobs.db`, which is why *what is this
  worker doing* is a question a human can answer with a SELECT.
- Idempotency claims and the outbox are tables.

And half of it is JavaScript structures with a hand-written reader each.

- Presence keeps `Map<channelId, Map<connId, PresenceMember>>` plus a second
  pending map and a timer per channel (`packages/junction/src/transport/presence.ts`).
- Channels keep connection sets and a per-principal grouping built fresh at
  broadcast time (`packages/junction/src/transport/channels.ts`).
- Node state, config scope, in-flight calls and the plugin registries each keep
  their own. `grep -rc 'new Map(\|new Set(' packages/junction/src` counts them;
  the count is not written here because nothing regenerates it.

**The devtools plugin is where that split is paid for.** A panel is written per
subsystem because each subsystem's state has a different shape and only its own
module can read it, which is precisely the custom diagnostic code the article
says a table removes.

---

## The proposal

One in-memory SQLite database per process, holding the state the process itself
is made of — connections, channel subscriptions, presence members, in-flight
calls — with the existing tables (cache, idempotency) free to move into it or
stay where they are. `bun:sqlite` is already a hard dependency and junction is
already bun-only, so this adds no dependency and no build step.

Two things fall out that are not available today.

**A query surface instead of a panel surface.** *Who is subscribed to what on
this node*, *which principal holds the most sockets*, *which calls have been
in flight longest* are joins over that database, so devtools becomes one query
box and stops growing a reader per subsystem. The same query runs from `fli
tinker` against a live process, which is the article's *inspect with SQL rather
than a memory dump* applied where FJS currently cannot.

**A consistency claim that is currently informal.** Presence today is a map of
maps kept in step with a set of connections by the code that edits both. As one
transaction over two tables with a foreign key, *a presence member whose
connection is gone* becomes unrepresentable rather than merely unlikely.

---

## The second half: activating a snapshot

The article's sharpest mechanic is separable from the rest. A background loader
writes a refreshed snapshot into staging tables and then **activates it in a
single transaction**, so no request can observe a half-refreshed world.

**FJS has nothing shaped like this, and today it needs nothing shaped like
this** — the finding is worth recording because it reads like a gap and is not.
Reference state here is revised one key at a time, and each revision is already
atomic with respect to a reader: `createTenantConfigStore` memoizes a promise per
tenant and `invalidate(tenantId)` drops exactly one, so the next `load()`
re-resolves that tenant and no other (`packages/junction/src/core/config-scope.ts`);
the tenant pool sets and deletes per id (`packages/litestone/src/tenant.js`);
caravan's `schedule` / `unschedule` name one job. **Nothing in this repo reloads
a whole table of reference data under live traffic**, so there is no window in
which a request sees half of one.

It becomes a real question the first time something does, and three candidates
would arrive together: a tenant registry refreshed from a control plane rather
than resolved lazily per host, a rate or pricing table an app reads per request,
and orion's flow definitions if a flow edit is ever to take effect without a
restart. At that point *one owner for activating a reloaded snapshot* is an
Invariant-4-shaped row that does not exist, and the answer is the article's: a
generation column or a staging pair, flipped once, never a mutation walked
key by key while readers are running.

**Until one of those lands this is a shape to keep, not work to schedule.**
Recording it costs a paragraph; rediscovering it costs whoever writes the first
live reload.

---

## What it costs, and what would kill it

**The hot path is the whole risk.** A `Map.get` is nanoseconds and a prepared
SQLite step is microseconds, and a broadcast touches subscription state per
connection. A fan-out to a thousand sockets that pays a query per recipient is
not a trade this repo should take. Two things make it plausible anyway: presence
already batches its flush behind a timer on purpose, and a broadcast's per-recipient
grading is already work per recipient rather than a map lookup. It is still the
measurement this proposal lives or dies by, and it should be measured before any
of it is built — `bench/audit-bench.mjs` is the nearest existing harness and
0.9 already says nothing watches these numbers.

**The failure that would make it worse than today** is keeping a Map beside the
table for speed. That is two origins for one fact with no check between them,
which is the disease this framework is organized against; either the table is the
state or the idea is refused.

**A partial adoption is legitimate and is probably the way in.** Presence and
subscriptions alone would exercise the whole argument — they are the state
devtools most wants to query and the state most likely to drift out of step —
and the rest can stay as it is indefinitely.

---

## Graded against `PHILOSOPHY.md` § V

Answered before anything was built, which is the only reason the answers mean
something.

- **Another origin of truth?** No, if it replaces the structures; yes and fatally
  if it sits beside them. Named above as the kill condition.
- **Concept budget?** Adds none for an app developer — this is internal to
  junction and visible only as *devtools takes SQL*. It adds one for a junction
  contributor: the runtime db.
- **Whose complexity?** The problem's. A server holding sockets, subscriptions
  and presence has relational state whether or not it is stored relationally;
  today the relations are maintained by hand.
- **Predictability?** Improves it. *What is this process holding* gets one
  answer with one query language instead of a panel per subsystem.
- **Derived rather than restated?** This is the derivation — the devtools panels
  are the restatement, and they go away.
- **Exactly one owner?** Yes, junction's transport layer, and that is also what
  makes it severable.
- **Boundary explicit?** The DDL is the boundary and it is readable. Weaker than
  it sounds: nothing yet says a subsystem may not keep private state beside it.
- **Failure proportional?** A wrong row here is a wrong diagnostic, not a wrong
  answer to a user — except for presence, which is broadcast, so the blast radius
  is one channel's membership.
- **Can it be wrong silently?** Yes, in exactly one way, and it is the reason to
  do it: today two structures can disagree and nothing notices. A foreign key
  makes that disagreement unrepresentable. The artefact is the schema itself.

**Tier (§ VII): Assessment.** It proposes and is not cited as behavior.

**Adjudication in tension (§ IV): batteries vs. smallness.** The runtime db is
core rather than a battery — it is the transport's own state — so it must stay
small and must not grow toward *everything junction knows*. Nothing here touches
preservation vs. evolution: there is no spelling being defended.

---

## Open questions

- ~~**Is the per-broadcast cost affordable?**~~ **Answered 2026-10-09 (`FJS-D749`): A — Measure first. A bench fans one broadcast out to a thousand sockets over today's maps and over tables, and adoption waits on a stated threshold.** Measure before building. If a
  thousand-socket fan-out regresses measurably, the answer is presence-only
  adoption or nothing.
  - **A** — Measure first. A bench fans one broadcast out to a thousand sockets over today's maps and over tables, and adoption waits on a stated threshold.
  - **B** — Keep the hot path in maps, and have devtools copy them into a `:memory:` database when someone asks. Broadcasts cost nothing extra, and the foreign-key claim is lost.
  - **C** — Adopt presence alone without measuring, since presence is where the foreign key earns its place, and leave channel subscriptions in maps.
  - **Recommend A** — then C if the fan-out regresses. Nothing in `packages/junction` measures broadcast cost today, so any answer without the bench is a guess. B is a second copy of the maps that can go stale, which is the scatter the paper exists to remove.
- ~~**One db or two?**~~ **Answered 2026-10-09 (`FJS-D750`): A — Two: the cache keeps its own `:memory:` database in `packages/junction/src/cache/index.ts`, and the runtime database holds transport state only.** Cache is already its own `:memory:` database with its own
  eviction. Folding it in buys a join nobody has asked for.
  - **A** — Two: the cache keeps its own `:memory:` database in `packages/junction/src/cache/index.ts`, and the runtime database holds transport state only.
  - **B** — One: the cache and the idempotency claims move into the runtime database, so one connection answers everything the process holds.
  - **Recommend A** — The paper names the runtime database as core rather than a battery, and *batteries vs. smallness* says core stays small. The cache already has an owner and its own eviction, and B buys a join nobody has asked for.
- ~~**Does `fli tinker` reach a live process?**~~ **Answered 2026-10-09 (`FJS-D751`): A — No: `fli tinker` stays a console that boots at a standing over the app's database, and the runtime state of a running server is read in devtools.** It boots at a standing against the
  app's own database; querying the runtime state of an already-running server is
  a different connection, and devtools is the surface that has one.
  - **A** — No: `fli tinker` stays a console that boots at a standing over the app's database, and the runtime state of a running server is read in devtools.
  - **B** — Yes, through devtools: `fli tinker --attach <url>` sends its query to the running server's devtools endpoint, under the devtools auth.
  - **C** — Yes, through the file system: the runtime database is a WAL file under `.cache/`, and any process opens it read-only.
  - **Recommend A** — then B once the runtime database exists and devtools has a query box. B reuses the one surface that already has a connection to the process, where a new channel would add a second owner. C writes in-memory state to disk on every change, which defeats the first question.
