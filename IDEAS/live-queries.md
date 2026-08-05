# Idea — Live queries: a subscription scoped to a query, not to a service

**Status: IDEA + LIVE DEFECT.** Dated 2026-08-04. The *transport* described below
exists and works; the *query scoping* does not, and its absence is three silent
data-correctness bugs in shipped code. Claims about current behaviour were read off
the source with line numbers named; the design half is unbuilt. See `VERIFYING.md`.

---

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

None of them throws. All three are the silent-wrong-data class.

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
than discovered later.

**2. Pagination is genuinely unanswerable.** Nothing can know whether a new row
belongs on page 3 without asking the server. The honest design is: live for
unpaginated and first-page lists, and a `stale` signal beyond that which a view can
render as "3 new — refresh". Say it out loud; the alternative is a list that is
quietly wrong past the fold.

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

1. **`matchesQuery(fields, record, query)`** in `field-rules.js`. Must cover exactly
   the operators `parseWhere` / `translateOps` accept — no more. Same discipline as
   the validator: *if the server does not emit it, it does not belong here.* Returns
   `true | false | unknown`.
2. **Sort-aware insertion** — `orderBy` is already known to the caller and already
   parsed server-side by `parseSort`.
3. **Inbound dispatch through the pipeline** — the store remembers the `query` and
   `findParams` its last `find` ran with; an arriving event enters as
   `ctx.method = 'created' | 'patched' | 'removed'` and is applied to the store on the
   way out. This needs one mechanical change: the dispatcher is a `switch` on method
   with no short-circuit (`resource.js` ~664–670), so there is currently no path where
   a `before` hook decides an outcome and the network call is skipped.
4. **A `stale` signal** for the paginated case.

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
- **Custom action events are treated as upserts** (`client/index.ts:486-489`). Under
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
