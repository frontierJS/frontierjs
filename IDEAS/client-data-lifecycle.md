# Idea — The client-side data lifecycle has no owner

**Status: IDEA + THREE LIVE DEFECTS.** Dated 2026-08-06. Claims about current
behaviour were read off the source with line numbers named; the design half is
unbuilt. See `VERIFYING.md`. Overlaps `live-queries.md` deliberately — that file
argues the *subscription* should be scoped to a query; this one argues that the
subscription, the request and the write are three faces of one missing owner.

---

## Trigger

A survey of ten problems every fullstack framework has to answer, and what the
elegant fix looks like in each. FrontierJS came out strong on everything the
**compiler or the schema** owns — signals, `<mesa:boundary>`, batched includes,
field rules, gates — and weak on everything living in **imperative client glue**.
Three of the ten landed in the same place:

| | Problem | Where FJS is |
| --- | --- | --- |
| 1 | A stale response clobbers a newer one | **closed 2026-08-10** — `FJS-082` |
| 2 | An optimistic update that rolls back cleanly | nothing exists repo-wide |
| 8 | A mutation on one screen, five stale views elsewhere | design right, three holes |

That is not three features. It is one absence: **nothing in the repo models the
lifetime of client-side data.** Sierra's `createResource` is a hook pipeline over
a pass-through client; it has no model of *time*, so anything that depends on
ordering, on a value being provisional, or on two views naming the same row has
nowhere to live.

## Where FJS actually stands

### The good part, and it is genuinely better than the industry default

`client.resource(name)` opens one socket and wires `created`/`patched`/`removed`
into a `Store` (`packages/junction/src/client/index.ts:501-509`). Several
resources share the socket.

This is entity invalidation by **announcement**, not by polling or by a key
graph the caller maintains. TanStack Query's `invalidateQueries` is a thing you
have to remember to call and can get wrong; here the server says what changed
and every subscriber already knows. The mental model is smaller and it is right.

### Hole 1 — a load has no identity — **closed 2026-08-10**

It was one unconditional line: read rows, set the store. Two overlapping
`load()` calls resolved in arrival order, so the slower earlier request won if
it landed second — type `ac`, type `acme`, and the store showed `ac` until the
next keystroke, with nothing thrown and nothing logged.

A load is now stamped when it is issued and only the newest stamp writes the
store; the superseded caller still receives its own rows. `FJS-082`.

What that does NOT do is cancel the request: a superseded read is still sent,
still answered, and still paid for. Cancellation needs the owner this file
argues for — it is a property of the load's lifetime, not of one call site.

### Hole 2 — a store holds rows, not entities

The store is per-`resource()` call. Two `createResource('orders')` calls in two
route files are two stores holding two copies of the same rows, and an event
updates both only because both are subscribed to the same service — not because
they point at the same node. Nothing keys a row to an identity across the app,
so nothing can say "this row is provisional" or "put that row back".

### Hole 3 — the announcement is not complete

- **`FJS-010`** — Litestone's `onEvent` has zero Junction subscribers. An
  `asSystem()` write from a Caravan job, a seeder or a migration announces
  nothing, so the store silently misses every write that did not come through a
  service. This is the one that matters most: the guarantee is "you never
  invalidate", and it is false in a way you cannot see.
- **`FJS-011`** — every event is upserted regardless of the query, so a row
  patched *out* of a filter stays in the store.

`FJS-011` is also what blocks optimism specifically: a store that cannot remove
a row on a filter miss cannot roll one back either.

## The idea

One owner for the lifetime of a client-side value, the way `toFieldErrors` is
one owner for a thrown value. Three capabilities, one seam.

### 1. A load is keyed by its query, and only the latest wins

```js
// resource().load(query, params)
const key = identityOf(query, params)      // stable, order-insensitive
_latest = key
const rows = (await svc.find(query, params)).data
if (_latest !== key) return rows           // superseded — return, do not store
store.set(rows)
```

Staleness defined by **dependency identity, not arrival time**. A race stops
being a thing you can have rather than a thing you have to remember to guard,
which is the same move the Mesa compiler already made for `<mesa:boundary>`:
`FJS-073`'s fix derives a boundary's watch set from what its body *reads*, so a
region cannot be held behind a value it does not use. The rule is already in the
repo, one realm over.

**Escape hatch, already correct and already shipped:** `service.find()` returns
rows and never touches the store. Custom race logic goes there. It is narrow —
using it opts one call out, not the resource.

### 2. Optimism as a transaction, not a try/catch

```js
await orders.mutate(
  () => orders.service.patch(id, { status: 'paid' }),
  { optimistic: row => ({ ...row, status: 'paid' }), id },
)
```

The store already has `upsert` and `remove`, and the server's `patched` event
already corrects the record — so the missing half is only the *rollback*, and
the snapshot needed to perform it. Making it one call is what stops every call
site hand-rolling a different snapshot discipline, which is the failure mode the
survey named.

Ordering rule that has to be stated, or this is worse than nothing: **a server
event supersedes an optimistic value for the same id.** Otherwise a rollback
races the very `patched` frame that made it unnecessary.

**Escape hatch:** raw `store.upsert` / `store.remove` for a reconciliation that
is not a revert.

### 3. One node per row

Key the store by `idField` across resources of the same service, so five views
of one order are five subscribers to one node rather than five copies. This is
what makes 1 and 2 composable instead of per-store, and it is the precondition
for `live-queries.md`'s query-scoped subscription to be expressible at all — a
query view is a *filter over the entity set*, which needs an entity set.

## Sequencing

Nothing here is safe to build in the stated order, because the correctness bugs
sit underneath the features.

1. **`FJS-010`** — an announcement that misses writes makes every layer above it
   a liar. Blocked on `FJS-D04` (how a subscriber attaches to `onEvent` after
   construction).
2. **`FJS-011`** — filter-aware event handling. Also unblocks rollback.
3. **Load identity (`FJS-082`)** — small, self-contained, no dependency on the
   two above. Could go first if a quick win is wanted; it just does not fix the
   others.
4. **Entity keying**, then optimism on top of it.

## Why this is worth doing

Every one of the framework's real wins converts a class of bug into something
you cannot express: a schema-declared gate, a content-addressed scope id, a
compiler-derived watch set, a batched include. The client data layer is the one
place where the framework hands you a primitive and trusts you to be careful —
and the three defects above are exactly what that trust has cost so far, all
three of the silent-wrong-data class.

## Relationship to the other files

- `live-queries.md` — the subscription half. Its query-scoped subscription is
  the natural consumer of the entity keying proposed here, and its `FJS-011`
  is item 2 of the sequencing above.
- `derived-suspense.md` — the *pending* half of the same lifetime. A load with
  an identity is also a load that can report whether it is in flight, which is
  the input `<mesa:boundary>` already consumes for script-level `await`.
- `one-mental-model.md` — the argument that a seam belongs to one owner.
