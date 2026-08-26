---
id: client-data-lifecycle
status: partial
dated: 2026-08-06
revised: 2026-08-25
---

# Idea — The client-side data lifecycle has no owner

**Status: RULED and PARTLY BUILT — [`FJS-D138`](../DECISIONS.md#fjs-d138).**
Steps 2–6 of the ruling's build order shipped 2026-08-25: the node registry,
lists as views, the TTL, `resource.record(id)` and the optimistic overlay —
closing [`FJS-518`](../ISSUES.md#fjs-518) and, with it, the two absences this
file was written about. **What is left is cursor paging** (step 7, Hole 4),
which is a separate axis and is not ruled.
Dated 2026-08-06, revised 2026-08-25 after an audit of the tree and a sweep of
the prior art. **Two of the four holes below are closed** — a load has an
identity (`FJS-082`) and the announcement reaches writes that came through no
service (`FJS-010`, with `FJS-011` and `FJS-270` making the store filter- and
order-aware). The two that remain are the two that were always the substance:
nothing keys a row to an identity, and paging is by position. The first is now
ruled and has a build order; the second is a separate axis and is not ruled.
The measured defect is [`FJS-518`](../ISSUES.md#fjs-518). Overlaps
`live-queries.md` deliberately. See `VERIFYING.md`.

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

### Hole 2 — a store holds rows, not entities — **ruled, unbuilt**

The store is per-`resource()` call — `const store = new Store<T>()` inside
`resource()`. Two `createResource('orders')` calls in two route files are two
stores holding two copies of the same rows, and an event updates both only
because both are subscribed to the same service, not because they point at the
same node. Nothing keys a row to an identity across the app, so nothing can say
"this row is provisional" or "put that row back".

**Measured 2026-08-25, and the sharp end is not the duplicate copies.** A
detail read does not go through the store at all: `product = await
products.service.get(id)` in `example/web/src/routes/products/[id].mesa`, `entry
= await portal.service.get(id)` in basecamp's `ServiceHealthBody.mesa`. Those
land in a plain variable, and no announcement can reach a plain variable — so
on a framework whose headline is *the server says what changed, you never
invalidate*, every detail screen in the repo is stale the moment somebody else
writes the row. Filed as `FJS-518`.

### Hole 3 — the announcement is not complete — **closed**

- ~~**`FJS-010`**~~ — **closed 2026-08-16.** Litestone's `onEvent` had zero
  Junction subscribers and no way to gain one after construction, so an
  `asSystem()` write from a Caravan job, a seeder or a migration reached the
  database and neither the bus nor a browser heard it. `db.$tapEvents(fn)` is the
  post-construction subscribe (`FJS-D04`) and `announceDataWrites` is the
  Junction half. It announces in three shapes, because Litestone knows which it
  is: the row, a `changed` carrying a count where the write held no row, and a
  named move under the move's own name (`FJS-463`).
- ~~**`FJS-011`**~~ — **closed 2026-08-15.** Every event was upserted regardless
  of the query, so a row patched *out* of a filter stayed in the store. The store
  now asks (`matchesQuery`) and takes such a row out.
- ~~**`FJS-270`**~~ — **closed 2026-08-15.** A pushed row was in the query and in
  the wrong place in it. `place()` inserts at the sorted position off the same
  `parseSort` the server compiles, trims to the page, and moves a row whose sort
  key a patch changed. What no browser can answer is paging, so past page 1 the
  row is refused and counted on `stale`.

That was also what blocked optimism specifically — a store that cannot remove a
row on a filter miss cannot roll one back either. All three are in, so the
removal path, the placement and the announcement are no longer what stands
between here and an optimistic write. **What stands there now is Hole 2.**

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


---

## The prior art, and the one asymmetry that matters

Swept 2026-08-25. Everyone who has solved this converged on the same three
parts, and the disagreements are about lifetime and about how a mutation is
confirmed — not about the shape.

| | entity set | a list is | optimism is |
| --- | --- | --- | --- |
| Meteor | minimongo collection | a cursor over it | latency compensation |
| Apollo · Relay | normalised store, `__typename:id` | a field policy over it | an optimistic response |
| TanStack DB | collection | a live query | an overlay on immutable synced data |
| Zero · Replicache | client-side store | a ZQL query | pending mutations replayed on the new server state |

**List-as-view is unanimous.** Nobody keeps a parallel copy of a row per query;
the query names ids and the row lives once.

**The most useful single fact is a refusal.** TanStack Query declines normalised
caching on the record, and the reason given is that doing it correctly needs a
way to infer or ingest a schema, which is more opinion than a library may hold.
That is the objection that kills this everywhere it is not a framework — and
FrontierJS emits the schema. The same asymmetry runs through the whole file:
Apollo's longest-standing pain is pagination in a normalised cache, where an
application hand-writes a `keyArgs` and a `merge` per paginated field, and
`$checkOrderBy` plus the declared unique keys are exactly the inputs that make
that derivable here (Hole 4).

**Three answers to lifetime, and the newest is the cheapest.** Apollo is
reachability GC with `retain`/`release`; Relay is retain around a subscription;
both are among the most-complained-about parts of either library, because a
lifetime the application has to remember is a leak with extra steps. Zero uses a
TTL per query instead. A TTL also answers *list → detail → back* for free.

**Two answers to optimism.** TanStack DB returns a `Transaction`
(`pending | persisting | completed | failed`, an `isPersisted.promise`, automatic
rollback when the handler throws) and — on Electric — has the handler return the
server's `txid`, which the client awaits: **confirmation keyed to the mutation,
not to the row.** Replicache and Zero go further and rebase: rewind to the last
server version, apply the server's patch, replay the pending mutations on top,
git-style. Rebase needs the client to be able to re-execute a mutation locally,
which means the gate, the row policies and the validators in the browser — that
is `compass`, not this.

**And an ordering datum.** TanStack DB shipped normalised collections in 0.1 and
persistence with offline support in 0.6. Normalise first, persist second, which
is the order this file already argued for.

## The ruling

[`FJS-D138`](../DECISIONS.md#fjs-d138), 2026-08-25. Four things, four owners:

| | holds | keyed by | dies |
| --- | --- | --- | --- |
| **node** | the synced truth for one row | model + id | a TTL after the last view lets go |
| **view** | the ids a query answered, in order | the query | with its subscriber |
| **overlay** | a submitted mutation not yet confirmed | the mutation | on confirmation, or on rollback |
| **draft** | text somebody is typing | the form | with the form |

The fourth row is the point. `FJS-341` was a live store defeating `@version` —
a push moved a number nobody had read and the save carried it — and it was fixed
by keeping the copies apart. A shared node reopens that by default, so the
separation is stated rather than rediscovered: **the node is the truth, the view
remembers what it read, and unsubmitted text is in neither.** An optimistic
mutation and a draft are not the same thing.

The rest, in one line each, with the argument in the ruling:

- **Keyed by the model, not the service** — junction holds no schema, so the
  name is passed in the way `match` already is. Two services over one model are
  one row.
- **The incremental placement stays** — `insert`/`drop`/`place`/`verdict` are
  the expensive half a query engine buys and they are already correct. The
  entity map goes underneath. No dataflow engine.
- **`store.get()` keeps answering rows**, materialised, so no screen changes.
- **Lifetime is a TTL**, not a reference count. No `retain` in application code.
- **A detail read is a view of one** — `resource.record(id)`, the same path with
  the id as its query. `service.get(id)` stays raw and dead, exactly as
  `service.find()` does.
- **The overlay carries INTENT, not the resulting value**, which costs nothing
  now and is what admits a rebase later.
- **Confirmation is mutation-keyed** — the `Idempotency-Key` already claimed in
  `callService`, and `@version` for which revision.

## Sequencing

The correctness bugs are gone; what is left is a build, and it is not in the
order the features are interesting in.

1. ~~`FJS-010`~~ · ~~`FJS-011`~~ · ~~`FJS-270`~~ · ~~load identity (`FJS-082`)~~ — all closed.
2. ~~**The node map**, model-keyed, in junction's client.~~ **Done 2026-08-25.**
   `junction/src/client/nodes.ts`. jetty still gets it by importing rather than
   by a second repair, and that pass is not made yet (`FJS-493`).
3. ~~**Lists hold ids**, `store.get()` materialising.~~ **Done** — and no screen
   changed, because `useStore` is the one bridge and nothing calls the store
   directly.
4. ~~**TTL.**~~ **Done** — `nodeTtlMs`, default 30s.
5. ~~**`resource.record(id)`**~~ **Done**, and proven in a browser:
   `verify:live` watches a detail page while the order is paid from node, and
   is negative-controlled against `service.get(id)`. Closes `FJS-518`.
6. ~~**The transaction and the overlay.**~~ **Done 2026-08-25.**
   `resource.mutate(id, intent, run)`, with `save({ optimistic })` delegating.
   The overlay is on the node, carries the INTENT, and is settled against the
   MUTATION — so a second writer moves the truth underneath and a rollback
   reveals what they did. Asserted where it can be negative-controlled, which
   is not the browser: every in-flight marker a page offers is also true for a
   moment after the call answers.
7. **Cursor paging** (Hole 4), separately and afterwards — cheaper once a list
   holds ids, and still carrying its own two open questions.

## Why this is worth doing

Every one of the framework's real wins converts a class of bug into something
you cannot express: a schema-declared gate, a content-addressed scope id, a
compiler-derived watch set, a batched include. The client data layer is the one
place where the framework hands you a primitive and trusts you to be careful —
and the defects above are what that trust has cost so far, every one of them of
the silent-wrong-data class.

## Relationship to the other files

- `live-queries.md` — the subscription half. Its query-scoped subscription is
  the natural consumer of the entity keying ruled here, and the framing it still
  wants (the matcher dispatched through the resource's hook pipeline rather than
  wired into the store) is a question about the **view**, which is now a thing
  with a name.
- `offline-first-and-release.md` — `compass` is built through this store, not
  around it. The overlay carrying intent is what makes a mutation queue and a
  rebase additive rather than a rewrite.
- `derived-suspense.md` — the *pending* half of the same lifetime.
- `one-mental-model.md` — the argument that a seam belongs to one owner.
