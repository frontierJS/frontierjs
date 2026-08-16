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
- ~~**`FJS-011`**~~ — **closed 2026-08-15.** Every event was upserted regardless
  of the query, so a row patched *out* of a filter stayed in the store. The store
  now asks (`matchesQuery`) and takes such a row out. Ordering and paging are the
  part no client-side matcher can answer and remain open as `FJS-270`.

`FJS-011` was also what blocked optimism specifically — a store that cannot
remove a row on a filter miss cannot roll one back either. That half is now
available: the removal path exists and is tested.

### Hole 4 — pagination is `offset`, and `offset` is wrong for the case this framework is best at

Added 2026-08-12, from a sweep for what a developer still wires up by hand. Verified:
`ctx.directives` is `{limit, offset, orderBy, select}` and the word *cursor* does not
occur in Junction's bridge or core. Offset is the only paging the framework has.

Offset paging is correct for a static table and wrong for a moving one, in a way that
is invisible while you build it. Rows shift under the reader between page 1 and page 2,
so an item that moved up is shown twice and an item that moved down is never shown at
all — no error, no gap, just a list that is quietly missing things. At depth it is also
the slow query, because `LIMIT 20 OFFSET 40000` counts forty thousand rows to discard
them.

**It sits worst next to the framework's best feature.** A `channel:` subscription pushes
inserts and deletes into a store that is simultaneously paging by position, and there is
no coherent answer to *what does page 3 mean now* — offset paging and live queries are
each fine and are incompatible. That interaction is the reason this belongs in this file
rather than as an API-realm feature request.

The replacement is well understood everywhere and fiddly to hand-roll: a cursor is a
position in a **total** order, so it needs the sort key plus a unique tiebreaker, an
encoding, and a direction. **The reason it belongs to FJS rather than to the
application is that the framework already knows both halves.** `db.$checkOrderBy()` is
the one definition of what may be sorted by and why — and its `reason` field already
separates *no such field* from *`@computed`, so SQLite can neither sort nor paginate by
it*, which is exactly the distinction a cursor has to make. The schema states the
unique keys. So the tiebreaker is derivable, an illegal cursor is refusable by the same
mechanism that already refuses an illegal sort, and the seam to add it to is one that
already exists on every flavour of client.

Two things to decide rather than assume. **A cursor is opaque or it is not** — an
encoded key is a promise the client will not construct one, and the moment it is
readable somebody filters on it. And **`offset` stays**, because a numbered page is a
legitimate UI and `Pagination.mesa` renders one; the question is which is the default
and whether a live resource may use offset at all.

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
2. ~~**`FJS-011`** — filter-aware event handling. Also unblocks rollback.~~
   **Done 2026-08-15.**
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
