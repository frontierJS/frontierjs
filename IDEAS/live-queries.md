# Idea — Live queries: a subscription scoped to a query, not to a service

**Status: IDEA, and all three of its defects are now closed.** Dated 2026-08-04;
revised 2026-08-15. The *transport* described below exists and works. **Query
scoping now exists in the narrow form § The design proposes** — `matchesQuery` in
`field-rules.js`, handed to junction's `resource()` as `match` (`FJS-011`), plus
sorted placement and a refusal past page 1 counted on `stale` (`FJS-270`). What
is still unbuilt is the FRAMING — the
matcher is wired into the store rather than dispatched through the resource's hook
pipeline (§ *There is no new API*), so a pushed record still runs no `after` hook
and an app cannot replace the matcher for a query it can decide and the framework
cannot. Read the tables below as the design; read `packages/sierra/CHANGES.md`
2026-08-15 for what shipped. See `VERIFYING.md`.

---

## Sibling

`client-data-lifecycle.md` argues that this file's `FJS-011` is one of three faces of
the same absence — nothing models the lifetime of client-side data — and that the
entity keying it proposes is what makes a query-scoped subscription expressible at
all: a query view is a filter over an entity set, and there is no entity set today.
Read them together; neither is complete alone.

## Trigger

Remult's `liveQuery`:

```ts
repo(Task).liveQuery({ where: { completed: false } })
          .subscribe(info => tasks = info.applyChanges(tasks))
```

A subscription bound to a **query**. The server tracks it per connection and pushes
changes over SSE, including the case that matters most — a row that *stopped
matching* is pushed as a removal even though it was only patched.

## Where FJS actually stands

**The transport is done.** `callService` announces a mutation once and
`publishToChannels` fans out to the channels a service declares
(`packages/junction/src/core/service.ts`). `client.resource('leads')` opens the
socket, wires `created`/`patched`/`removed` into a `Store`, and notifies subscribers
(`packages/junction/src/client/index.ts:480-489`). Sierra surfaces it through
`createResource`. A reactive array that updates when the server changes is shipped
and works.

**The query is missing entirely**, and that is the whole substance of the feature.
`resource()` subscribes to the *service*. Every event for `leads` lands in every
`leads` store, and the store does not know what query populated it.

### Three defects this produces today

None of them throws. All three are the silent-wrong-data class, and **all three
are closed** (2026-08-15). 1 and 2 by `FJS-011` — the store asks whether a pushed
record is still in the query its rows answer, and takes out one that is not. 3 by
`FJS-270`, in the shape this file argues for: sorted insertion where the order is
known, and past the first page a refusal counted on `stale` rather than a guess.

1. **Filter leak.** `load({ status: 'active' })`, then anyone creates a row with
   `status: 'draft'` → `client/index.ts:480` upserts it unconditionally. A draft
   appears in the active list.
2. **No exit event.** Patch a row from `active` to `archived` and the handler is an
   *upsert* — the row is updated in place and stays in the active list. It does not
   leave; it becomes wrong. This is the failure Remult's `applyChanges` exists to
   prevent, and the one users report as "the framework is broken".
3. **Order and paging ignored.** `Store.upsert` appends
   (`client/index.ts:947`). A list loaded `orderBy: createdAt desc, limit: 20`
   receives new rows at the *bottom* and silently grows past 20.

The docstring at `client/index.ts:441` promises "the store wires up to real-time WS
events automatically". It does. It just does not promise, or deliver, that the store
still means what `load()` said it meant.

---

## The design

**Do the matching on the client, from the schema.**

Remult needs server-side state: a registry of live queries per connection,
re-evaluated on every mutation. That is the expensive part and the reason it does
not scale casually.

FJS does not need it, because the client already holds the constraint table.
`packages/sierra/src/junction/field-rules.js` is a leaf module with the types,
enums, formats and relations, and `validateAgainstFields(fields, data, mode)` is
already a *does this record satisfy these rules* function. A sibling —

```js
matchesQuery(fields, record, query)   // → boolean
```

— is the same shape of function, and it makes a live query entirely client-side:

| event | today | with a matcher |
| --- | --- | --- |
| `created`, matches | upsert ✓ | upsert at the `orderBy` position |
| `created`, does not match | **upsert ✗** | ignored |
| `patched`, still matches | upsert ✓ | upsert, re-position if the sort key changed |
| `patched`, no longer matches | **upsert ✗** | **remove** |
| `patched`, now matches (was outside) | upsert ✓ (by luck) | insert |
| `removed` | remove ✓ | remove ✓ |

No server registry, no per-connection bookkeeping, no new transport, no SSE.

**It inherits the property that makes validation trustworthy.** `field-rules.js` is
deliberately a leaf with no import of the Junction client, so its rules can be
compared *directly* against junction's server-side ones from one `.lite` file rather
than against a copy. A client matcher gets the same treatment: it must agree with
`parseWhere` / `translateOps` (`packages/junction/src/core/litestone.ts`), and
because both are reachable from plain Node, that agreement is testable rather than
asserted.

### Where this sits between the two known positions

`website/projects.json` already records the Convex stance: *"Convex tracks what each
query read and re-runs it; FJS announces the mutation and lets the client decide.
That is cheaper and simpler, and it is honestly worse."*

Client-side matching is the middle term neither entry names. Convex re-runs queries
(correct, expensive, needs read-tracking). FJS today announces and hopes (cheap,
wrong at the edges). Matching is cheap *and* correct — the cost paid is that a
client receives events for rows it filtered out, which is bandwidth, not
correctness.

---

## Two constraints that bound the design

**1. A broadcast does not re-evaluate row policies per subscriber.** This is stated
deliberately in `publishToChannels` and is exactly why `channel:` is opt-in: `@@allow`
is enforced when a row is READ, and a broadcast hands every connection in the channel
rows it may never have been able to fetch.

Live queries inherit that and make it *worse*, by encouraging more services to
declare a channel. A client-side matcher does not help — filtering for relevance is
not filtering for permission, and a client that discards a row still received it.
**Per-subscriber policy evaluation is the harder problem sitting behind this one**,
and it should be named as a prerequisite for any default-on live behaviour rather
than discovered later. § *Per-subscriber deltas* below is the proposed answer.

**2. Pagination is genuinely unanswerable.** Nothing can know whether a new row
belongs on page 3 without asking the server. The honest design is: live for
unpaginated and first-page lists, and a `stale` signal beyond that which a view can
render as "3 new — refresh". Say it out loud; the alternative is a list that is
quietly wrong past the fold.

---

## Per-subscriber deltas — grading the fan-out, not the fetch

**Added 2026-08-05.** Constraint 1 above names per-subscriber policy evaluation as
the harder problem behind live queries and stops there. It is worth stating what the
answer looks like, because the framework is unusually close to it and nobody else
can copy it.

**The framing first.** A subscription is not a special transport path; it is the
network edge of one dependency graph. The client holds a signal, the server holds
the source, and a mutation propagates a *delta* along the edge instead of
invalidating a cache and triggering a refetch. That framing is worth adopting
because it is the projections axiom applied to the wire — but it must not become a
second announcement mechanism. `callService` is the single announcement point
(repo Invariant 4), so everything below happens **inside `publishToChannels`**, not
beside it.

**The mechanism.** At publish time the server has three things at once, which is the
part no other framework has:

1. **The row.** It is the payload — already in memory, not a query away.
2. **Each subscriber's level.** Every connection carries a session, and
   `sessionGateLevel(user)` (`junction/src/core/litestone.ts`) already grades it 0–7.
3. **The declared requirement.** `@@gate` on the model, `@guarded` / `@encrypted` on
   the column, `@allow` per field — all static, all already parsed.

So the fan-out can grade **per subscriber** before a byte reaches a socket:

| Case | Today | Graded fan-out |
| --- | --- | --- |
| subscriber below the model's read gate | receives the row | not sent |
| subscriber above it, row has `@guarded` columns | receives them | column stripped |
| field-level `@allow('read', …)` fails for this subscriber | receives it | field stripped |
| `@scoped` model, row belongs to another tenant | receives it | not sent |

The cost is a comparison per subscriber per field, against a table that does not
change between mutations — not a query, not a re-run, not a registry. Contrast the
two known positions: Convex re-runs each subscriber's query (correct, expensive);
Remult keeps a per-connection query registry (correct, stateful). Neither *can* grade
a push, because in both the permission lives in a handler rather than in the data.
**This is the same `only`-column property as `IDEAS/static-safety.md`, one realm over:
a broadcast is a publication, and the framework knows what each recipient is allowed
to be published.**

Where it stops, honestly:

- **A row policy that traverses a relation cannot be evaluated in memory.** An
  `@@allow` expression over the row's own columns plus `auth()` is a pure function of
  two things the server is holding; one that joins is a query per subscriber, which is
  Convex's cost reappearing. **Fail closed** — withhold the row and let the client
  refetch on its own credentials — and say so at subscribe time rather than
  discovering it under load.
- **Redaction changes the payload shape per subscriber**, so the matcher in the
  section above may be handed a record missing a column its query filters on. That is
  the same "cannot decide → refetch" outcome as a `select`, and it should route
  through the same hook rather than a second rule.
- **It does not make `channel:` safe to default on.** It makes it *safe to opt into
  without reading the source first*, which is the actual barrier today.

This is the strongest argument for the `live:` declaration in § Open questions: a
service whose policies cannot be graded in memory declares that once, and the server
refuses to broadcast rather than leaking by default.

---

## Interaction with `compass`

If the offline engine lands (`IDEAS/offline-first-and-release.md`,
`IDEAS/package-map.md`), the *right* live query is a reactive query over the local
SQLite with sync in the background — the local-first model — where matching, sorting
and paging are all just a query re-run against a database that happens to be in the
browser. That is a strictly better implementation and it makes the matcher above
redundant.

That is an argument about the internals, not about the API. Build the WS version now
and keep the surface identical, so the source of truth can be swapped underneath
without touching a consumer. **Do not** design the API around WS events — design it
around "a query whose results stay current", which is true in both worlds.

---

### There is no new API — it is the hook pipeline, run inwards

**Revised 2026-08-04.** An earlier draft proposed evolving `resource()`'s event
wiring directly. That was still thinking of pushes as a special path. They are not.

`createResource` already has a four-phase pipeline that *matches the API realm
exactly* — `before` / `after` / `around` / `error`, keyed by method with `all`
(`packages/sierra/src/junction/resource.js`). And **its context is already the
live-query descriptor**:

```
{ service, model, method, id, data,
  query,       // the filters — what a matcher tests against
  findParams,  // { limit, offset, orderBy, select } — what sorting needs
  params,      // browser-only scratch
  result, error }
```

A `find` that runs through that pipeline has stated its subscription in passing.
Nothing needs to be declared twice, so a resource is simply **live for whatever it
last loaded**, and `ctx.params` is the per-call opt-out (`load(query, { live: false })`).

The missing half is that hooks are **outbound only** — the pipeline is
`around:enter → before → [call] → after → around:exit`, driven by a method the caller
invokes. A pushed event arrives unprompted and has no phase to enter.

So: **dispatch an inbound event through the same pipeline as a synthetic method.**

```js
// framework-supplied defaults, and replaceable like any other hook
before: { created: [matchesQuery], patched: [matchesQuery] }
after:  { created: [formatDates] }              // an app's own, same as for find
```

Three things fall out that were being treated as separate problems:

- **The matcher is a hook, so "cannot decide" has an ordinary answer.** The default
  returns `unknown` and refetches; an app whose query touches a relation supplies its
  own. That is the framework's existing answer to *we cannot know this*, not a new
  mechanism — and it retires the open question below.
- **The client pipeline becomes symmetric with the server's.** Junction announces a
  mutation once in `callService`; the client receives once, through one pipeline, with
  the same four phases and the same context shape. Today a pushed record skips every
  `after` hook a fetched one runs — an inconsistency that is invisible only because
  pushes are rare in practice.
- **`error` already exists for a malformed push**, which currently has nowhere to go.

## What would have to be built

1. ~~**`matchesQuery(fields, record, query)`** in `field-rules.js`~~ — **built
   2026-08-15**, to this description: exactly the operators `parseWhere` /
   `translateOps` accept, returning `true | false | null`. Junction's `resource()`
   takes it as `match` and reloads on `null`; the reload is coalesced per burst.
2. ~~**Sort-aware insertion**~~ — **built 2026-08-15.** `parseSort` and the
   client's comparator are one module (`core/sort.ts`), so the caller's `orderBy`
   is read once for both ends.
3. **Inbound dispatch through the pipeline** — the store remembers the `query` and
   `findParams` its last `find` ran with; an arriving event enters as
   `ctx.method = 'created' | 'patched' | 'removed'` and is applied to the store on the
   way out. This needs one mechanical change: the dispatcher is a `switch` on method
   with no short-circuit (`resource.js` ~664–670), so there is currently no path where
   a `before` hook decides an outcome and the network call is skipped.
4. ~~**A `stale` signal** for the paginated case.~~ — **built 2026-08-15.**
   `resource().stale`, `{ get, subscribe }` like a store, cleared by `load()`.
   Counts what the list could not place: a new row past page 1, a gap a removal
   left behind a full page.

Steps 1 and 3 fix the three defects on their own and are worth doing regardless of
whether anything is branded a "live query".

## Recommendation

**No new API.** Not `resource.live()`, and not bespoke event wiring inside
`resource()` either — an inbound event is a pipeline dispatch like any other, and the
subscription is a side effect of having loaded. That keeps hooks as the one extension
point rather than adding a second concept beside them, and it is why this belongs in
Sierra's resource pipeline rather than in Junction's client `Store`.

Sequence: fix the leak first (defects 1–3), then decide whether the query-scoped
result deserves its own noun. It probably does not.

## Open questions

- **Does `matchesQuery` need to handle relations?** `where` can name a related
  field server-side. The client has `x-relations` but not the related *rows*, so the
  honest answer is probably that a query touching a relation is not live-able and
  must say so, loudly, at subscribe time.
- **What about a `select`?** A projected record may lack the columns the query
  filters on. Either live queries refuse a `select` that drops a filtered column, or
  the matcher reports "cannot decide" and the store refetches.
- ~~**Is "cannot decide" a first-class outcome?**~~ **Settled by the hook framing
  above.** `unknown` → refetch is the default `before` hook; an app that can decide
  replaces it. Kept here because the reasoning matters: a matcher forced to return a
  boolean has to guess, and guessing wrong is silent.
- **Does the inbound dispatch reuse `around`?** A push has no network call to wrap, so
  `around`'s stated purpose (loading state, retry, timing) does not apply — but
  excluding one phase from one direction breaks the "matches the API realm exactly"
  claim the pipeline currently earns. Probably run all four and let `around` be
  trivially satisfied.
- **Does this want a `live:` declaration on the service**, the way `channel:` is
  declared? That would let the server refuse to broadcast for services where
  per-subscriber policy cannot be satisfied — which is the security constraint above,
  expressed as a declaration instead of a warning.
- **Custom method events are treated as upserts** (`client/index.ts:486-489`). Under
  a matcher they get the same treatment as `patched`, which is probably right and
  should be stated rather than inherited.

## See also

- `IDEAS/package-map.md` — `compass`, and where a local-first implementation lands
- `IDEAS/offline-first-and-release.md` — the same seam from the offline direction
- `website/projects.json` — the Convex entry, which records the trade this refines
- `packages/junction/src/client/index.ts` — `resource()`, `Store`, the three defects
- `packages/sierra/src/junction/field-rules.js` — the leaf module the matcher belongs in
- `packages/junction/src/core/litestone.ts` — `parseWhere` / `translateOps`, the
  semantics a client matcher must agree with
