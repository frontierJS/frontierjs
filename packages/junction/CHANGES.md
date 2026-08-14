# Changes — @frontierjs/junction

## 2026-08-13 — the README's Conduit example taught two things that cannot work

Found while sweeping for `FJS-D29` (*agent* → *Outpost*), and the naming was the
smaller half.

**`kind: 'agent'` no longer exists** — the union member is `'outpost'`, so the
example as written was a type error for anyone who copied it.

**`auth: { type: 'hmac', secret: process.env.AGENT_SECRET }` never worked at all.**
A Conduit target carries a **ref**, resolved at send time; the HMAC signer reads
`ref` and nothing else. The documented form type-checks through the cast and then
fails every send with `auth_failed` naming credential `undefined` — *and* writes
the material into the registry, which `GET /conduit-targets` hands back. That is
the exact defect Basecamp hit and recorded in its own `CLAUDE.md`; the README has
been teaching it since.

Both fixed in place, with the ref/material distinction stated in the sample.

## 2026-08-13 — a service is a definition and a compiled runtime

`FJS-D01`, closing `FJS-016`. The ruling and the Feathers 5 comparison are in
`DECISIONS.md` § API design; this is what moved.

**The derived hooks install once** (`FJS-231`, found while planning this). A base
returns the MERGED hook map, the autoloader spreads a base back through
`createService`, and the second pass appended the schema-derived layer again — so
every autoloaded one-line service graded its `@@gate` and ran its validator
**twice per request**. Nothing caught it because nothing was wrong on the wire.
The four derived hooks are marked now (a WeakSet, invisible to a spread) and a
marked hook already present is skipped. Marked rather than matched by name: a
user hook called `gateAuth` is not ours, and letting it suppress the real one is
fail-open on the thing that enforces access.

**`methods:` declares.** It used to be an allow-list validated *against* a scan
of the object; it is now the source of truth, which is Feathers' shape and what
makes an action nameable after an option key — `cache`, `schema` and `channel`
were eaten by the deny-list with no error at declaration, at call, or anywhere
else. With no `methods:` the scan runs exactly as before, so every inline action
keeps working and no app in this repo changed.

**One parse step, one table.** `collectActions` runs at construction and lands in
`_actions`; dispatch, `/manifest`, the OpenAPI spec and `/metrics` read it
instead of each re-deciding what counts as an action. An action attached to a
service *after* construction still dispatches and warns once naming itself — that
was never a supported shape, but a silent 404 is the worst way to learn it.

**`describe()`** — `{ name, model, actions, methods, allowBulk, softDelete,
cache, idField, hooks, schemas? }`. The three advertisers stopped reaching into
`_meta`, `_schemas` and `_hookMap` through casts. Three readers of four
internals was three chances to describe a different service than the one that
answers the request, and `/metrics` did exactly that: it read `svc.actions`, a
key no service has, and reported `[]` for every service while `/manifest` listed
them correctly.

**`pipelines(appHooks)` is the one owner.** Gone: `_pipelines`,
`_compiledPipelines`, its hand invalidation, the four writers, the registry's
`hooks()` monkey-patch, and the three-way ladder in `callService` where the cache
**outranked the app hooks the transport had just passed**. The memo is keyed on
both inputs — the app map by identity, the service's own by a version `hooks()`
bumps — so a stale answer is unreachable rather than remembered, and a call now
always runs the hooks it was handed. One `svc.hooks()` call used to merge and
resolve twice and pass through `undefined` in between; it merges once now.

One hazard worth knowing: `app.hooks()` REASSIGNS `app._appHooks` rather than
mutating it, which is what makes identity a sound key. Anything that starts
mutating it in place defeats the memo silently.

**A built service is marked** — `Symbol.for('junction.service')`, non-enumerable,
and `createService` returns an already-marked object unchanged. The autoloader
tests the marker instead of asking `typeof service.hooks !== 'function'`, which
answered *was this built?* by inspecting one field's type. Non-enumerable
matters: `{...svc}` is a copy of the fields, not a service, and it is correctly
seen as unbuilt.

**Breaking, internals only:** `Service._pipelines` and `Service._compiledPipelines`
are gone; `Service` no longer has an index signature, so `svc.someAction` needs a
cast in TypeScript (`ServiceDefinition` keeps its signature — you *write* actions
there). Nothing outside this package read either field.

Typecheck baseline **211 → 199**, most of it one deleted line: an index signature
made `keyof Service` `string | number`, so `Omit<Service, …>` collapsed and every
`base.find` read as `unknown`.

Verified: junction 991 · testing 23 · conduit 193 · auth 88 · cli 363+25 ·
`example` verify 37 / live 14 / jobs 8 · `basecamp` verify 271/271.

## 2026-08-13 — three things you could not ask for

**The browser client can ask for a relation.** `FindParams` gained `populate`,
emitted as `$populate` on the query string and on the WebSocket frame alike.
The wire and the server had supported it from the start — the bridge parsed it,
the service destructured `include` — so the only thing missing was the way to
say it, which meant a component could not declare its own data shape and
over-fetching was a decision made server-side in a hook. The server's spelling
travels unchanged (`'customer'`, `['a','b']`, `'customer:name+email'`), so there
is one grammar rather than a client dialect. A by-id `get` carries `params` too;
they used to be accepted and dropped on that path. `FJS-084`.

**`buildRoutes(app)` and the routes half of `/manifest`.** The HTTP surface is
emergent — services auto-mount, plugins register their own — and `hasRoute()`
answers a matching question, so *what is actually mounted* had no cheap answer.
`buildRoutes` reads the router rather than rebuilding from the registry, and
splits the auto-mounted `{service}` templates from everything a plugin or the
app registered. `fli api:routes` is the caller. `FJS-091`.

It found a defect on its first run against a scaffolded app: two identical
`OPTIONS /*` routes, because the scaffold configured CORS by hand *and* through
`config.http.cors`. `FJS-225`.

**`IEventBus.stats()`** — `{ events: Record<string, number>, total }`, beside
`hasListeners` rather than replacing it. A yes/no is the wrong resolution for
anyone chasing a missing announcement, and the handler map is closure-private,
so nothing could count subscribers. An event whose last handler unsubscribed is
omitted rather than reported as zero. `FJS-143`.

**Documented rather than fixed:** `after` means after the METHOD, not after the
call succeeded. A later `after` hook throwing makes the call report failure with
an earlier hook's email already sent, and there is no commit-scoped phase to put
the effect in. README and `CLAUDE.md` now say so, with the two workarounds.
`FJS-089` stays open for the phase itself.

## 2026-08-13 — one owner for `apiPrefix`; an Idempotency-Key means something; a `$defs` miss is audible

Three things that read as handled and were not.

**`apiPrefix` moves every route the app registers, not just the service ones.**
It used to be applied by `registerServiceRoutes` alone, so a plugin's
`app.get()` landed at the root while the services beside it moved. Four plugins
in this package hand-resolved `app.config.apiPrefix` to compensate;
`@frontierjs/auth` did not, and an app under `/api` therefore served its login
at `/auth` — with the browser client's default looking for it under the prefix,
so the two ends never met. The shortcuts (`get/post/put/patch/delete`) now apply
it, `registerServiceRoutes` registers bare `/{service}` paths like every other
caller, and the four copies are gone. A route that must sit at a fixed path —
somebody else's callback URL, a probe path an orchestrator owns — is registered
on `app.http.router` directly, the layer beneath the shortcuts, which applies
nothing. The client's `authPrefix` composes with `apiPrefix` for the same
reason the plugin's `prefix` option does. `FJS-012`.

This moves paths in any app that sets a prefix, which is the fix rather than a
side effect of it: `example` now serves `/api/auth/login`, `/api/session`,
`/api/jobs` and `/api/health`, and one vite proxy entry replaced four.

**An `Idempotency-Key` executes once.** The header was parsed into request
metadata and consumed by nothing, so a double-submitted create ran twice while
carrying the value that says not to — and Conduit spends the opposite side of
the same contract outbound, asking other people's APIs for a guarantee this one
advertised and did not provide. `core/idempotency.ts` claims the key in
`callService`, the one path every transport takes, so a repeat replays the first
answer without running the pipeline: no second hook, no second write, no second
announcement. Scoped to `(service, method, principal, key)` — replay skips the
pipeline and therefore the auth checks in it, so a key shared across principals
would hand one caller another's answer. A **failed** call releases its key,
because a failed request is one the caller may retry; a duplicate arriving while
the first is still running is a **retryable** 409 rather than a second parallel
execution. `config.idempotency` (`enabled`/`ttl`/`pendingTtl`) is on by default
and inert unless a caller sends a key. `FJS-088`.

The in-flight marker carries its own short TTL. It is the one entry nothing is
guaranteed to clear — a throw between the claim and the settle would otherwise
leave a key answering 409 for a day, turning one failure into a caller who can
never retry.

**The WebSocket path establishes request metadata at all.** It wrapped nothing
in `runWithMeta`, so `requestMeta()` was `undefined` for every socket call and
the correlation id was as HTTP-only as the idempotency key. Both now ride the
frame's `meta`, beside the id and the workspace.

**A model service with no field rules says so.** `autoValidate` stored `null`
for a `$defs` miss — and for a definition that would not compile — and said
nothing either way, so a service accepted unvalidated input in silence while the
schema declared `@email`, `@length` and `@gte`. It warns once per model now,
naming the service, the spellings tried and the compiler's own message. Only
when the accessor does resolve to a table: a service with no model at all is a
supported shape, and `getTable` already names every spelling when an unused CRUD
method is called on one. `FJS-013`.

## 2026-08-12 — `ctx.id` is a string on both transports

Over HTTP the id is a path segment and can only ever be a string. Over the socket
it rides a JSON frame, so `patch(42, …)` handed a service the number `42` while
`PATCH /leads/42` handed it `'42'`. A handler comparing `ctx.id` to a row's own
id, or using it as a Map key, answered differently depending on whether a socket
was connected — and the browser client prefers the socket whenever one is up, so
the same code is correct in dev and wrong in production, or the reverse. The WS
handler now matches the transport that has no choice. `FJS-197`.

Found by `@frontierjs/testing`'s `verifyTransportParity()` on its first run
against a custom action, which is the one method shape the derived call set does
not cover.

## 2026-08-12 — a thrown status keeps its status, and a test server can bind port 0

`fromStatusCode` mapped fourteen codes to error classes and everything else to
`GeneralError`, whose `code` is 500. So an app throwing `{ status: 423 }` or
`{ status: 451 }` got a server error on the wire — not a narrower answer but a
different category, where the client stops retrying and the 5xx pages someone for
a refusal the app stated deliberately. An unmapped code in 400–599 now keeps its
status and loses only the class name, which is the part nothing on the wire reads.
`FJS-196`. It survived because every error junction itself throws has a class.

`http.start(port?)` and `http.port`. The argument overrides the configured port
for one bind and leaves configuration untouched; the getter reads back what was
bound. Together they are how a caller asks for **port 0** — an OS-chosen free
port — which is what makes a test server parallel-safe, and without the getter
there is no way to learn which port that was. `@frontierjs/testing`'s
`listen: true` is the first caller.

## 2026-08-11 — `autoSort`: an unknown `$orderBy` key is a 400, not an unsorted 200

`autoFilter`'s sibling, closing the quieter half of the same failure. An unknown
filter key at least answered an empty list, which a caller eventually notices;
an unknown sort key answered the **right rows in their original order** and said
nothing anywhere — no error, no warning, not even on the server, because the key
was quoted into SQL and resolved against the SELECT aliases, finding nothing. A
caller cannot see a sort that did not happen, so page 2 of a "sorted" list is
plausible and wrong.

```
GET /products?$orderBy=-bogusColumn   → 200, unsorted, silent
GET /products?$orderBy=shoutName      → 200, unsorted, silent  (a @computed field)
```

Both are now 400. Same division of labour as `autoFilter`: litestone's new
`db.$checkOrderBy` keeps the one definition of what is sortable, Junction
contributes the status code. The two refusals stay distinct — a field that does
not exist gets the typo suggestion litestone already computes, a `@computed`
field is told it cannot be sorted at all — because a caller can act on the
difference. A `@from` field sorts; it is SQL, not a JS function.

Installed on `find` beside `autoFilter`. A client that cannot answer the probe
no-ops rather than 500s, the same contract and for the same reason as
`FJS-117` — reading an unknown property off a Litestone client throws.

## 2026-08-10 — published to npm as `@frontierjs/junction@0.1.0`

Live on the registry, tag `latest`, public. Four manifest gaps closed first,
each of which fails at a different moment:

- **`publishConfig.access: "public"`** — a scoped package defaults to restricted,
  so the *first* publish of `@frontierjs/*` fails on payment rather than on
  anything about the code.
- **`files`** — the tarball was 131 files and 464 kB, carrying `tests/`,
  `example/`, `bun.lock`, `tsconfig.json` and the three state markdowns. Now 64
  files and 281 kB: `index.ts`, `src/`, `tools/` minus the seven repo-internal
  `check-*.mjs` audits, README and LICENSE. The bin needs `init.ts`, `setup.ts`,
  `repl.ts` and `build-app.ts` beside it, which is why `tools/` ships at all.
- **`LICENSE`** — the manifest said MIT and no file said anything.
- **`repository`** with `directory: "packages/junction"`, the monorepo form.

**Bun-only, and there is no version of this package that is not.** Node refuses
to strip types inside `node_modules`, so the import fails outright — and
compiling to JS would only move the failure later, because the transport is
`Bun.serve`, logging and static files are `Bun.file`, and cache and database
import `bun:sqlite`. `engines` already said so; the README now says it in the
first paragraph a reader arriving from npm will see, and that Quick start no
longer opens with `git clone <this repo>`.

Verified against the published artefact rather than the tree: **all 29 declared
subpath exports import from an installed copy** (the 29th, `/auth`, is
types-only, so zero runtime exports is the right answer), and the `junction` bin
runs from `node_modules/.bin`. 919 tests unchanged.

**This unblocks `@frontierjs/auth`** — it declares junction as a peer, and its
`FJS-003` fix was verifiable but unshippable while the peer was a 404. A `bun
add` of the auth tarball into an empty project now resolves junction from the
registry and imports.

## 2026-08-10 — a load that has been overtaken no longer writes the store

Closes `FJS-082`. `resource().load()` was one unconditional line — read rows,
set the store — so two overlapping loads landed in arrival order. A
search-as-you-type box typing `ac` and then `acme` showed the results for `ac`
whenever the first request was the slower one, and stayed there until the next
keystroke. Nothing threw and nothing logged.

A load is stamped when it is issued, and only the newest stamp may write the
store. The superseded request is not cancelled and its own caller still gets its
rows back: the ordering problem belongs to the shared store, not to whoever
awaited the call. `service.find()` is unchanged — it returns rows and has never
touched the store.

919 tests (was 916). The three new ones make the earlier request the slower one,
which is the only arrangement that fails.

## 2026-08-10 — a dropped WebSocket frame is held and re-sent, not lost

Bun's `ws.send()` returns the bytes written, `-1` when the frame was buffered
under backpressure, and **`0` when it was discarded**. Junction ignored that
number at all five send sites, and the `BunWS` type declared `send` as returning
`void`, so no call site could have read it.

A dropped `service_result` left the caller's promise pending until its own 30s
timeout: no error, no close, nothing logged, and a screen sitting on "Loading…"
while the server believed it had answered. A dropped `event` frame is quieter —
nothing is waiting on it, so the row is never updated and every open tab is
stale. Measured on one socket with 200 concurrent reads of a ~1MB payload: 193
never settled, and a call issued afterwards answered in 34ms, which is what makes
it read as *the socket is fine*.

`transport/outbox.ts` is now the one owner of *put this frame on that socket*:
send, hold what was dropped, flush on `drain`. Once anything is held everything
queues behind it — a frame that jumps the queue arrives before one sent earlier,
and an event stream that reorders is worse than one that pauses. The queue is
bounded by `http.wsMaxQueued` (default 8MB); past the cap the socket is closed
with 1013, the client rejects every in-flight call and reconnects, and a consumer
that cannot keep up is told rather than quietly served nothing.

**No knob for Bun's own buffer.** `maxBackpressureLimit` is accepted and ignored
— measured on 1.3.11, a 64KB, a 1MB and a 16MB limit all start dropping at the
same ~16.9MB — so exposing it would be a control that changes nothing.

Found while probing `FJS-139` (a reload from a channel subscriber that does not
settle) and filed as `FJS-145`. It has that defect's exact signature but does not
explain its volume — three small agent reports are nowhere near 16.9MB. FJS-139
is closed separately, as not reproducible: its only reproduction turned out to be
masked inside the drive that found it, and with the mask removed basecamp passes
262/262 three runs consecutively. Which change stopped it is not known, and the
register says so rather than claiming this one did.

8 tests, both halves mutation-verified — the integration case delivers 200 of
200 frames with the outbox and 98 of 200 without it. 905 pass.

## 2026-08-10 — the METHOD decides list vs single, not the shape

`wrapResult` guessed. Any `{ data, total }` was read as a paginated list and
rebuilt from `total`/`limit`/`offset`/`data`/`errors`, whatever method produced
it. One guess, two silent failures, closed together:

- **`FJS-140`** — an action answering rows **plus** a summary lost the summary.
  `dashboards.kinds` returned `{ total, data, statSources, portalServices }`;
  the browser got the nine kinds and neither vocabulary needed to render them,
  so the picker offered widgets it could not fill in. 200, no word.
- **`FJS-144`** — a `find` answering one object was wrapped as a `single`, which
  the browser client then read as an EMPTY list. A screen rendering nothing
  while the API was correct — visible only from a browser.

`wrapResult(raw, object, method)` now reads:

    find             → a list, or ResultShapeError
    { data, errors } → a list, any method — the bulk partial-write protocol
    Array            → a list
    anything else    → a single, which unwraps whole and loses nothing

So an action keeps everything it answers, and the one method that promises a
list is the one that has to produce one. `data` must be an ARRAY to be a list:
`{ data: {…}, total: 3 }` used to pass `isListResult()` and reach the browser as
a list nothing could iterate.

`ResultShapeError` (exported from `core/envelope.ts` and re-exported by the
client, `status` 500) names the service, the method, what arrived — `typeof` for
a primitive, the key list for an object — and any keys a list envelope cannot
carry. **The browser client asks the same function**, as `find`, instead of
carrying a hand-copy of the rule; that copy is how the two ends drifted apart in
the first place. A find answering `null` throws too — a 204 is not an empty page,
and over the wire the two are indistinguishable.

Not gated on a dev flag: the browser has none it can trust, and a dev-only throw
leaves production with exactly the silent failure being removed. An app that was
already broken pays a loud error; a correct app pays nothing.

Blast radius, checked rather than assumed: ~15 list-shaped ACTIONS in basecamp
become singles, which reach the browser as the same `{ total, limit, offset,
data }` minus the wrapper — every consumer in the repo reads `.data`/`.total` or
`Array.isArray(raw) ? raw : raw?.data`, and nothing reads `envelope.kind`. Every
model `find` (Litestone's base, basecamp's `findScoped`) already answers exactly
the allowed keys. `kind` and `object` are allowed keys so that a pre-`kind`
envelope from an older server is still accepted by the client.

13 tests; 897 pass.

## 2026-08-09 — `SessionContext.credentialId`

One additive field on the interface, for the auth-provider side of `FJS-135`.
An API-key session says which user it is and, now, which credential proved it.
Without it two keys belonging to one person produce sessions that are
identical, so nothing can record per-key usage, show a key's last-used time, or
hold one key to a limit the other does not have.

Set on the `apiKey` path only; a session token leaves it absent.
`@frontierjs/auth` fills it in — see that package's CHANGES for the three
defects this was part of fixing, none of which were in Junction.

Also worth knowing, and not changed here: **the HTTP transport resolves every
Bearer token through `auth.verifySession()` and calls `IAuth.verifyApiKey`
nowhere.** That is why an issued key authenticated nothing until a provider
learned to fall through. If a third provider is ever written, that fall-through
is its job too — `transport/http.ts:385` is the only door.

## 2026-08-08 — a collection-level custom action was unreachable from the browser

The bridge dispatches on the `X-Service-Method` header **before** it looks at
`params.id`, so the server has always accepted an action about a whole service
rather than one row. The browser client interpolated the id unconditionally, so
the only way to reach one was to invent a throwaway id and post to
`/{service}/null`.

`action(name, id?, data?, query?)` now posts to the service root when `id` is
null or omitted, and carries a plain filter query: `?limit=50`, not the
`$`-prefixed directive syntax `buildQueryString` emits. An action declares its
own query vocabulary; the bridge still splits `$` keys off as directives if a
caller uses them. Values that are null are dropped rather than sent as the
string `"null"`.

Found writing basecamp's fleet-wide event feed (`servers.feed`) and its flag
`resolve` — neither has a subject row to name. 4 tests; 884 pass.

## 2026-08-06 — a capability probe must survive a client that throws

880 tests (was 879). The junction half of `FJS-117`.

`autoFilter` guarded itself with

```ts
if (typeof client?.$checkWhere !== 'function') return
```

which reads as a safe feature test and is not one here. **A Litestone client
throws on an unknown property** rather than answering `undefined` — deliberately,
so a typo'd accessor is loud — so that line is a throwing expression, and it sat
just *outside* the `try` guarding the call it protects. When `$checkWhere` turned
out to be missing from the scoped proxies, every list read by a signed-in caller
became a 500 complaining about a table nobody had written.

Litestone was fixed (it now answers on every flavour of client). This side is
fixed too, and independently: `db` is whatever the app handed `createApp`, and a
stand-in that cannot answer the question must **no-op**, not take down the
request. The probe now reads inside a `try`, and the call goes through the
captured reference rather than a second property read.

## 2026-08-06 — an unknown filter key is a 400

879 tests (was 871). Closes `FJS-109`.

```
GET /products?bogusColumn=7   →  200 {"data":[],"total":0}
GET /products?limit=100       →  200 {"data":[],"total":0}     ← belongs on $limit
GET /products                 →  200 {"data":[],"total":0}     ← genuinely empty
```

Three situations, one answer, no error. It cost an hour in `example/`'s
prerendered catalogue, which fetched, resolved, rendered "0 of 0 products" and
reported nothing wrong.

**Litestone knew the whole time.** It validates where-keys, rejects them on
writes, and on reads prints `Unknown field 'bogusColumn' … Valid fields: id,
name` — to the server's stderr, invisible to whoever typed it.

So `autoFilter` asks rather than re-deriving: `db.$checkWhere(accessor, where)`
keeps one definition of the rule, and Junction contributes only the status code.
Exactly the division `gateAuth` already makes with `@@gate`. Re-deriving it here
against JSON Schema would have drifted on relation sub-filters, `$raw`, edges and
the AND/OR/NOT descent.

The message names **every** bad key, not the first — a caller fixing a filter one
round trip at a time is what the silent 200 already put them through — plus the
typo suggestion, the filterable fields, and the directives it was probably meant
to be:

```
Unknown filter key 'nme' — did you mean 'name'?. Filterable fields on product:
id, name, price. Paging and sorting are directives, not filters — use $limit,
$offset, $orderBy, $select.
```

What does NOT trip it: `$or`/`$and`/`$not` (structure), a real directive (the
bridge has already split those off, Invariant 10), and an operator filter — the
browser client serializes `{price:{$gte:1}}` as `?price={"$gte":1}`, so the key
stays a column. A client without `$checkWhere` no-ops: *I cannot judge this* is
not *this is wrong*.

Two existing tests asserted on the **length** of a compiled `before` list and
broke on the second derived hook. Both now filter the exported `DERIVED_HOOKS`,
which is what their own comments already said they wanted — one of them in as
many words.

Worth knowing: `?price[$gte]=1` now 400s. It never worked — `rawQuery` is flat,
Junction has no bracket parsing — it just used to fail as an empty page.

## 2026-08-06 — the "model not found" message lists models

871 tests (was 869).

`getTable`'s failure message ends with *Available: …*, and it had never once
printed a list. It built one with `Object.keys(scopedDb)`, and a real Litestone
client's proxy threw on that (`FJS-014`, fixed the same day) — so the `try/catch`
around it swallowed the throw and the message silently degraded to no list, at
the moment a caller most needs one.

With enumeration working the list appeared and was **wrong**: `Available:
asSystem, author, post, query, sql`. Dropping `$`-prefixed names cannot tell a
model from a method. It now filters against `$schema.models`, using Invariant 2 —
the accessor is the model name with a lowercase first letter — so the test is
exact rather than a guess about which names look like tables.

The `try/catch` stays. `db` is whatever the app handed to `createApp`, and a
stand-in that refuses to enumerate must not turn *your model name is wrong* into
a stack trace. Its comment no longer claims Litestone is the reason.

Two tests, and they use a **real** Litestone client: every existing test in that
file used a plain object, which is precisely why the list went unverified for
four days.

## 2026-08-06 — `retryable` reaches the client

869 tests (was 866).

A status cannot say whether repeating a request could work, and a 409 is the case
where that matters most. Litestone throws two: `VersionConflictError` and
`TransitionConflictError` are races — re-read and re-apply — while
`TransitionViolationError` is a domain refusal whose own message is the right
thing to show. All three arrived as an identical `Conflict`, so a client had to
phrase every one as the weaker of the two, turning *this can never be legal* into
*try again*.

Both litestone classes already declared `retryable`; it stopped at the boundary.
`toFrameworkError` now adopts it alongside `status`, and `FrameworkError.toJSON`
serializes it **only when the originating error declared one** — an absent flag
stays absent rather than becoming a `false` that claims knowledge. Both transports
land it at `err.data.retryable`; sierra's `isStaleWrite()` is the reader.

Same contract as `status`: if you own the error class, set the field. No mapper,
no registration.

## 2026-08-06 — a session now reaches the Data boundary with an `id`

866 tests (was 842 — 24 new across `data-principal`, `patch-defaults` and
`method-policy`). Typecheck unchanged at 212.

### Row policies matched nothing, for every Junction caller

`SessionContext` names the caller `userId`. Litestone's policy language reads
`auth().id` — its documented spelling, the one `@default(auth().id)` and every
`@@allow` example in its docs use. `$setAuth(ctx.auth.user)` handed the Data
boundary a principal with **no `id`**, so:

```litestone
@@allow('read', userId == auth().id)
```

compared a column to `undefined` and matched nothing. No error, no warning — an
empty list, which reads as "there is no data" rather than "the policy could not
see who is asking".

**Gates were fine**, because `sessionGateLevel()` was written against Junction's
shape. So the translated half worked and the untranslated half failed quietly,
which is why this survived: an app with `@@gate` and no `@@allow` never notices.

New: `toDataPrincipal(user)` — the one owner of that translation, applied at both
`$setAuth` call sites (`withLitestoneDb` and `getTable`). Sibling of
`sessionGateLevel()`: same boundary, same direction, one for the ordinal gate and
one for the policy predicate. Everything else passes through by name; an explicit
`id` wins, so a caller already speaking Litestone's shape is untouched.

Found by `example/`, where a signed-in user's own notifications were invisible to
them and plainly there under `asSystem()`. It went on to uncover a second defect
it had been masking — see litestone's `CHANGES.md` for the audit log's `actorId`.

### A PATCH no longer invents values for absent keys

`jsonSchemaToJunctionSchema(model, schema, 'update')` dropped required-ness and
kept every field's `default`, and `validate()` fills a default in for any absent
key — so `PATCH /orders/3 {"note":"x"}` reached the model as a whole record. On
an ordinary column that silently reset it; on a column under `@@transitions` it
answered `409 Cannot transition order.status from 'shipped' to 'pending'`, which
reads as a broken state machine and is not one. Found by a Caravan job writing a
tracking code onto a shipped order.

### `methods:` works on both factories

The allow-list was read by `createService` and neither read nor forwarded by
`createBaseService` — the factory the loader is built around. So the same
`methods: 'readOnly'` that makes an audit trail append-only through one factory
did nothing at all through the other, and the only symptom was a write that
succeeded. It is carried through now and resolved in the one place that
validates it against the actions that exist.


## 2026-08-06 — the transport can resolve a session from a cookie

854 tests (was 842 — 12 new in `tests/auth-cookie.test.ts`). Typecheck unchanged
at 212.

`extractToken()` read only `authorization: Bearer` and `x-api-key`. So
@frontierjs/auth's documented `cookieAuth: true` set an httpOnly cookie that
**nothing ever read back**: `ctx.user` stayed null and a cookie-only request to
any protected route — including auth's own `GET /auth/me` — was 401. The mode
handed you a session you could not use. `ISSUES.md` FJS-002.

```ts
app.http.setAuthCookie('session')   // now reads it, alongside Bearer / x-api-key
```

### Off by default, and that is a security decision

Not caution about breaking things. A Bearer token has to be attached by script,
so a cross-site request cannot forge one. A cookie is attached by the browser
automatically, which is what makes CSRF possible at all — so an app takes that
exposure deliberately or not at all. What makes it safe when taken is the
`SameSite=Lax` @frontierjs/auth sets: the browser withholds the cookie from
cross-site POST/PUT/PATCH/DELETE, and those are the requests that change
something. An app that sets its own session cookie `SameSite=None` re-opens the
hole and Junction cannot tell.

### One switch, not two

The auth plugin calls `setAuthCookie('session')` from its own `register()`, so
`cookieAuth: true` simply works. Making the app *also* write
`config.auth.cookie` would have left a half-configured state that reproduces the
original bug exactly — cookie set, cookie ignored. `config.auth.cookie` remains
the path for a hand-rolled `IAuth` that issues its own cookie and has no plugin
to declare it.

### Also

- **Explicit beats ambient.** Bearer and `x-api-key` both win over the cookie, so
  "act as someone else for this one call" stays possible from a browser that is
  holding a session cookie.
- **The WebSocket upgrade reads it too.** The upgrade is an ordinary browser
  request and carries the cookie; without this a cookie-authenticated app
  connected its socket **anonymously** and every user-scoped channel stayed
  silent — with no error anywhere, because an unauthenticated socket is a legal
  state.
- **An emptied cookie is not a token.** `clearCookie()` leaves `session=` with
  `Max-Age=0`; treating `''` as a token would fire a guaranteed-failing
  `verifySession` on every request after sign-out.

7 of the 12 tests fail if the cookie branch is removed. The auth package's marker
test — `KNOWN GAP: a cookie alone does not authenticate a request`, asserting
401 — is now `a cookie alone authenticates a request`, asserting 200.

## 2026-08-06 — a custom action announces, like any other write

836 tests (was 830 — 6 new in `tests/event-origin.test.ts`). Typecheck unchanged
at 212.

An action changed a row and told nobody. `callService`'s announcement block was
gated on `AUTO_EVENT_MAP[method]`, which holds only the five CRUD writes, so
`POST /orders/4` + `X-Service-Method: pay` published nothing — not to the
channel, not to the in-process bus.

**Both halves of the seam already existed.** The browser client has listened for
action events since it was written:

```ts
// client/index.ts — "Custom action events (e.g. 'moved', 'archived') — treat
// as upserts. The server publishes them with the updated record, same as patch."
svc.on('*', (method, raw) => { … store.upsert(unwrap(raw), idField) })
```

The server never sent one. The client was waiting for post nobody was posting.

```ts
const eventName = AUTO_EVENT_MAP[method] ?? (isAction ? method : undefined)
```

An action announces under its **own** name — `orders pay`, no past tense
invented for it, matching what `publish()`'s hook form has always put on the
wire. Reads are excluded by name (`find`, `get`); an action that only reads
(search, stats, export) opts out with `ctx.dispatch = false`, the one existing
switch, which suppresses both consumers.

**Why it stayed invisible.** Every app re-issued `find()` after an action, so
the acting tab looked correct and every *other* tab went stale in silence.
Found by `example/web/test/verify-live.mjs`, a drive whose watcher tab is signed
out and never acts: it saw `orders created` and `orders removed` cross the
socket and no `pay` between them, while the row it was rendering silently kept
saying `pending`. Reverting the one line above fails 4 of its 12 assertions.
The example's orders table dropped its refetch and re-grades from the broadcast.

Recorded as [FJS-D21](../../DECISIONS.md).

## 2026-08-06 — a service can say what it does not answer (`methods:`)

830 tests (was 809). Typecheck unchanged at 212.

`createService({ model })` answered every CRUD verb through the base **with
validation**, whether or not the file declared one. Declaring only `find()` did
not make a service read-only — it made the writes invisible. Basecamp's `/audit`
is an append-only trail and an admin could `POST` a forged row into it, verified
over HTTP, and the only defence was four hand-written `MethodNotAllowed` stubs
per service. Opt-out safety, with no warning that you had not opted out.

One key, two forms:

```ts
createService({ name: 'audit', model: 'AuditEvent', methods: 'readOnly' })
createService({ name: 'tickets', methods: ['find', 'create', 'approve'] })
```

Absent means everything, so no existing service changes.

The allow-list is the general form because a narrower method set is not only
ever "read only" — the second example says *no patch, no remove, one action*,
which a boolean cannot express. `'readOnly'` is sugar on the same key rather
than a second option.

**Where the check lives is the point.** It is in `callService`, ahead of the
hook pipeline, because that is the one path every caller takes: an in-process
`app.service('audit').create()` is refused exactly as the wire is. A policy
enforced in the transport would have left jobs, engines and hooks — which is how
an audit trail actually gets written — free to do what a request cannot. Ahead
of hooks because the policy is structural rather than authorization, so there is
nothing an identity could change and no reason to run a `before` hook's side
effects for an impossible call. Accepted consequence: an anonymous caller now
gets 405 where it used to get 401.

Also:

- CRUD and actions share one list. Being *defined* is not being *offered*.
- An unknown name throws at construction — `['find','gett']` would otherwise
  silently block `get` and only read as broken after a 405 in production.
- `/manifest`, `/metrics` and the OpenAPI spec filter by the same predicate, so
  what a service answers and what it advertises cannot drift. `/manifest` also
  stops omitting `update`, which its hardcoded CRUD list had dropped.

21 tests in `tests/method-policy.test.ts`; **7 fail if the enforcement is
removed**. Ruled as `FJS-D07`, closes `FJS-004`, `DECISIONS.md` § API design.

## 2026-08-06 — a service_error frame dropped the field list

809 tests (was 806).

The server answers a failed WS service call with `FrameworkError.toJSON()` —
`{ name, message, code, data }` — and `data` is where a validation failure's
per-field list lives. The client took `message` and `code` and dropped the rest,
so the same 400 carried field errors over HTTP and nothing but a joined sentence
over the socket.

**WebSocket is the default transport**, so that was the shape a form saw in
production while the HTTP fallback it was developed against looked correct. The
rejection now carries `data`, shaped to match the HTTP path exactly (the parsed
error body goes on `.data`, so `err.data.data` is the list in both) — which is
what lets one unwrapper, sierra's `toFieldErrors`, serve both transports.

3 tests in `client-ws-errors.test.ts`, driving the real `onmessage` handler
rather than resolving the pending call by hand.

## 2026-08-04 — the client's transport rule, actually applied

803 tests (was 796).

The documented rule is in this package's README: *"CRUD methods prefer WebSocket
when connected, fall back to HTTP automatically. File uploads always use HTTP."*
WebSockets are the default when one is available; HTTP is the fallback. Two
methods did not follow it, and the fallback had a hole with no bottom.

**`action()` and `restore()` were unconditionally HTTP.** `find`, `get`,
`create`, `patch` and `remove` all check `_wsReady` first; those two never did,
which made a custom action the only service call that ignored a live connection.
The WS handler dispatches any method name generically — it passes `method`
straight to `bridge.internal` — so there was never a reason for the exception.
Both now prefer the socket. `action()` also honours the file exception, because
multipart cannot travel over it.

**The HTTP fallback recursed forever.** `_httpFallback`'s `default` branch
called `svc.call()`, which is `_wsCall()`, which routes back to `_httpFallback`
when the socket is down. A custom action with no connection bounced between the
two indefinitely — asynchronously, so no stack overflow ever pointed at it and
the call simply never settled. The default branch now calls `action()`, the HTTP
form of a custom action, and `restore` gained its own case.

Seven tests in `tests/client-transport.test.ts`, half of them on the no-socket
path. Verified in `example/` over CDP as well: clicking a transition button with
the socket up sends `orders.pay` as a WS frame and makes **zero** HTTP POSTs.

The README's dispatch-by-header section said what the HTTP form looks like
without saying it was the fallback; it now says both.

## 2026-08-04 — autoValidate says the sentence the schema declared

796 tests (was 787).

`FieldDef` gains `label` and `messages`, read from JSON Schema `title` and
`x-messages`. Every generated message in `core/schema.ts` now consults the
authored wording for the keyword that failed, and builds its fallback from the
label rather than the column name.

The point is that Sierra's `field-rules.js` does exactly the same thing from
exactly the same document. If these two disagreed the user would get one
message before the request and a different one after it — worse than either
alone. `tests/field-messages.test.ts` and
`packages/sierra/tests/field-messages.test.js` are deliberately the same
fixtures and the same expectations.

Presentation is read off the FIELD's own schema, never a `$ref` target:
Litestone titles every enum `$def` with the type name, so following the ref
would make `status OrderStatus` report itself as "OrderStatus". `mapProp` is
now a thin wrapper that attaches label/messages from the raw property around
the existing resolver.

## 2026-08-04 — the startup banner reports the Data realm

787 tests (was 781). Additive; no behaviour change to any request path.

`createApp()`'s banner covered routes, services, health and docs, and said
nothing about the database. "Is Litestone actually loaded, and against which
file?" had no answer short of issuing a request and seeing what came back.

It now prints a second line in the same startup phase:

```
INFO 🚀 shop v1.0.0     {"url":"…","routes":22,"services":3,"prefix":"/api",…}
INFO 🗄  litestone       {"models":8,"enums":1,"gated":"7/8",
                         "databases":"main → ./db/shop.db (sqlite), audit → ./db/audit (logger)"}
```

Four fields, each earning its place:

- **models / enums** — the shortest honest answer to "did the seed parse".
- **gated** as `n/total` — a schema reading `0/24` is one whose access control
  is not declared. Worth seeing daily rather than discovering in an audit.
- **databases** — name → **resolved** path and driver. This is the one that
  pays for the line: a schema declaring `database main { path … }` silently
  overrides `createClient`'s `db:` option, so the file being written is not
  always the file that was passed. Printing the resolved path makes that
  visible at boot instead of three confusing test runs later. (Verified in both
  directions — `example/` declares a path and shows it; `sierra/example` passes
  `db: ':memory:'` with no declaration and shows `:memory:`.)

`describeDataRealm()` lives in `core/litestone.ts`, beside the rest of the
Data↔API seam. It is entirely duck-typed and returns `null` — no line — for
anything that is not a Litestone client, including a raw `bun:sqlite` handle.
It also catches: `createApp({ db })` accepts Proxy-based clients that *throw*
on unknown property access (Litestone's own scoped proxy does exactly that),
and a banner helper that throws would take the app down at the last startup
phase, after the port is already open. Six tests in
`tests/describe-data-realm.test.ts`, four of them on that failure path.

Newest first. Everything below the 2026-08-02 block was applied during the
2026-07-25/26 FrontierJS pass, against the archive dated 2026-07-26
(`_built: 2026-05-27`).

## 2026-08-02 — the error boundary is extensible

`src/core/errors.ts`. `toFrameworkError()` is the single point where a thrown
value becomes an HTTP status, and it used to recognise a **closed** world:
Junction's own `FrameworkError` subclasses plus two Litestone error names by
string. Every other package's errors fell through to `GeneralError` — a 500 for
what the thrower had modelled as a 401 or a 404.

That bit `@frontierjs/auth` and `@frontierjs/caravan` independently, and each
worked around it differently: auth wrapped every one of its own routes in a
per-route try/catch that re-mapped statuses, caravan just shipped 500s.

Recognition order is now:

1. `instanceof FrameworkError`
2. a mapper registered with **`registerErrorMapper(fn)`**
3. a numeric **`status` / `statusCode` / `code` in 400–599** on the error
4. `err.name` matching a known class name (`NotFound`, `ValidationError`,
   `AccessDeniedError`, …)
5. `GeneralError` (500)

**Rule that follows from step 3: if you own the error class, give it a
`status`.** No registration, no import of Junction — which is how auth and
caravan now map statuses while depending on nothing here. Use
`registerErrorMapper` only for errors you cannot modify, e.g. a third-party
library's.

Consequence elsewhere: auth's per-route wrapper is **gone**, and its errors map
correctly everywhere rather than only on `/auth/*`. Raw routes (`app.get` /
`app.post`) can now simply throw.

---

## 2026-08-02 — plugin contract reworked

`src/core/app.ts`. Four changes, each closing a silent failure:

- **`register` is `=> void`, not `=> Promise<void>`.** `configure()` runs it
  synchronously and never awaited it, so an async `register` had its body run
  after the app was already assembled — with nothing to say so. Async setup
  belongs in `boot()`. Returning a promise from `register` now warns at runtime,
  and its rejection still aborts `start()` rather than becoming an unhandled
  rejection.
- **`requires: ['mailer']`** declares ordering. Checked once at startup, before
  any `boot()`, against both presence *and* `configure()` order.
- **`app.provide(name, value)`** is the guarded namespace claim. It assigns the
  real property — so the `AppConduit` / `AppJobs` / `AppNotify` interface
  augmentations keep resolving — but **throws if the name is taken**, replacing
  silent last-write-wins.
- **Startup is ONE named phase list**, `runStartPhases(bindHost)`. There were
  two hand-maintained sequences numbered 0, 0a, 0b, 0c, 1, 3, 4, 4.5, 4.6, 5, 6,
  7, with the test path documented as mirroring "phases 1, 4.5, 4.6" — a subset
  that could drift from the real one without any test noticing. `start()` and
  `_startForTest()` now run the same list; phases flagged `needsHost`
  (load-config, autoload-services, listen, ready-hooks, signal-handlers,
  announce) are skipped by the test path. **Add a phase to the list, never to
  one caller.**

The plugin protocol is `{ name, register, boot, ready, shutdown, requires }`.

---

## 2026-08-02 — webhook audit: four bugs, one of them a payload leak

`src/plugins/webhooks/index.ts`.

### `findForEvent` pattern-matched on the event name

```sql
events LIKE ('%"' || ? || '"%')     -- ← the parameter is a caller-supplied event name
```

SQL `LIKE` metacharacters in the **event name** therefore matched other
subscriptions. An event named `user_created` was delivered to a hook subscribed
only to `userXcreated` (`_` matches any character), and an event named `%`
fanned out to **every registration in the table**.

That is a payload leak: a partner receives correctly-signed data for an event
they never subscribed to, and the delivery looks entirely normal at both ends.

Matching is now `json_each()` equality. **Don't reintroduce pattern matching on
a caller-supplied name.**

### `updateDelivery` used `??`, so nullable columns could never be cleared

`updates.error ?? current.error` makes an explicit `null` mean "leave it alone".
A delivery that failed once and then **succeeded on retry** kept reporting the
`HTTP 500` it had recovered from, and kept a stale `next_retry_at` — so the
delivery log said a working webhook was broken.

Use `key in updates ? updates[key] : current`. This is a shape, not a one-off:
any patch helper written with `??` has the same hole.

---

## 2026-08-02 — router: fixed and dynamic routes no longer share a keyspace

`src/transport/router.ts`. The method cache was one object, with dynamic routes
stashed under the key `'D'`. A route registered at **`/D`** normalises to
exactly `'D'` and collided: `build()` threw
`methodCache.D.push is not a function`, and `lookup()` would have returned the
bucket array as if it were a route.

The cache is now `{ fixed, dynamic }` — separate fields, no shared keyspace.
Found by a test probing `hasExactRoute`.

---

## 2026-08-02 — the startup banner advertised a `/health` that might not exist

The endpoint was always fine; the **advertisement** was fiction. The banner
asked `router.hasRoute('GET', '/health')` — which is a *matching* question:
"would a request for this path match something". Every app registers
`GET /{service}`, which matches `/health`. So every app printed a health URL
whether or not `healthPlugin()` was configured.

**`hasRoute()` is a matching question, not an existence one.** Use
`hasExactRoute(method, path)` when you mean "is this endpoint mounted", and
`routePaths(method)` to list where routes actually landed. The banner uses
`routePaths`, so `healthPlugin({ path: '/internal' })` is advertised at
`/internal` instead of being claimed at `/health`.

Fixed in the same place: `hasRoute(a) ?? hasRoute(b)` never evaluated `b` — `??`
only falls through on null/undefined and `hasRoute` returns a boolean.

---

## 2026-08-02 — `/metrics` read service keys that don't exist

`svc.actions` is not a key on a service — custom methods are ordinary
function-valued properties, and three other places already had a predicate for
that. `/metrics` reported every service as having zero custom methods, and
misreported `svc.allowBulk` the same way.

Both now go through `customMethodNames()`, the same predicate manifest and
OpenAPI use.

---

## 2026-08-02 — `app.conduit` was declared twice, and conduit always lost

Junction typed `conduit?: SomeShape` on `App` while `@frontierjs/conduit`
declared the same property in a module augmentation. **Declaration merging
requires identical types**, so the augmentation silently lost and `app.conduit`
resolved to `{}` at every call site — in the editor and in `tsc`, with the code
working perfectly at runtime.

Junction now exports an empty `interface AppConduit` and types the field
`conduit?: AppConduit` (`src/core/app.ts`); conduit augments **that interface**.

**If you add another `app.<thing>` from a plugin package, use this pattern — an
empty interface exported here, augmented there — not a property redeclaration.**
Junction's typecheck baseline dropped to **212** as a result; that is the current
number, not the 214/216/224/226 in older notes.

---

## 2026-08-02 — the dialect trap took 7 "test drift" failures with it

Junction carried 7 long-standing test failures filed as drift. They were not
drift: Junction was resolving a *registry* Litestone that still spoke
`Integer/Text/Real/Blob` while the fixtures were written in the current
`Int/String/Float/Bytes` dialect.

Junction (and auth) now take litestone as a `workspace:*` dev-dependency with a
`^1.1.0` peer, so in-repo code gets the workspace parser. All 7 pass. See
`packages/litestone/CHANGES.md` for the registry half.

---

## createBaseService now carries `name`, `hooks` and custom methods

`src/core/service.ts`.

It destructured only `{ model, db, paginate, allowBulk }` and returned the seven
CRUD methods, dropping everything else. That made the documented service shape
silently wrong:

```ts
export default createBaseService({
  name:  'leads',
  model: 'lead',
  hooks: { before: { create: [authenticate] } },   // ← discarded
})
```

It type-checked. The autoloader registered it, deriving the name from the
filename, and it served requests — with no hooks. For `authenticate` that is an
authorization hole producing no error, no warning, and a service that reads
correctly in review.

Only the spread form worked, because the loader reads hooks off the object you
export via `createService({ name: deriveName(filename), ...service })`:

```ts
export default { ...createBaseService({ model: 'lead' }), hooks: { … } }
```

Both forms work now. `name` and `hooks` are carried onto the return value, and
extra function-valued options become custom service methods — mirroring
`createLitestoneService`, which already supported all three.

Guarded against leakage: reserved keys (`model`, `name`, `hooks`, `db`,
`paginate`, `allowBulk`) are never exposed as methods. `db` in particular is a
function, so without that check it would have become callable over HTTP. And
when `name` or `hooks` are omitted, no key is added at all — an explicit
`name: undefined` would override the loader's filename-derived name with
nothing.

**New:** `tests/base-service-options.test.ts` — 10 tests. Verified against both
the old and new implementations: 3 fail before the change (`name`, `hooks`,
custom methods), all 10 pass after.

## WebSocket service calls dropped the id

`src/client/index.ts`, `src/transport/channels.ts`.

Reported from a running app, once the `channels()` plugin was registered and WS
calls actually started flowing:

```
leads.patch   websocket  ✗  Bulk patch is disabled on this service (set allowBulk: true)
leads.remove  websocket  ✗  Bulk remove is disabled on this service
leads.find    websocket  ✓
```

`find` worked; anything carrying an id did not.

The browser client wrote call extras under `params`:

```ts
const params = {}
if (id != null) params.id = id
send(JSON.stringify({ type: 'service_call', …, params, data }))
```

The server read them from `meta`:

```ts
const extraParams = (parsed.meta ?? {}) as Record<string, unknown>
const paramId     = extra?.id ?? data?.id
```

Nothing matched, so `svcCtx.id` stayed null. A CRUD method with no id is a bulk
operation by definition, so the service correctly refused it — the error was
accurate and the cause was three layers away.

`WSMessage` declares `meta` and has no `params` field, so the client was the side
in the wrong. It now sends `meta`; the server accepts either, so a client that
has not been updated keeps working.

**Why it hid for so long:** with `channels()` unregistered there is no `/ws`
route, so `_wsCall()` fell back to HTTP on every call — and over HTTP the id
travels in the URL path, which is a different code path entirely. The protocol
mismatch could only surface once the WebSocket transport was genuinely in use.
The `?? data?.id` fallback also masked it for `create`-shaped payloads that
happen to carry an id.

**New:** `tools/check-ws-protocol.mjs` — asserts both ends agree on the frame.

## createApp({ db }) — the database client is now an app option

`src/core/app.ts`, `src/core/litestone.ts`, `src/core/service.ts`.

Wiring a Litestone client used to take three steps in two files:

```ts
export const withDb = withLitestoneDb(db)        // core/hooks.ts
app.hooks({ around: { all: [withDb] } })         // app.ts
```

An option with exactly one correct answer is not an option. `createApp({ db })`
now takes the client, exposes it on `app.db`, and installs the scoping itself
when the client has `$setAuth`. Plain table-shaped clients — the ones
`createBaseService` adapts — are accepted and simply get no scoping.

`config.database.url` still works and still produces a raw bun:sqlite handle;
`opts.db` takes precedence.

### The bug this exposed: only one service factory scoped

`withLitestoneDb` seeded `ctx.locals.db` with the **root** client and left
`$setAuth` to `createLitestoneService`. `createBaseService` never called it at
all. So a service written with `createBaseService` ran unscoped, and a schema
declaring

```prisma
@@allow('read', ownerId == auth().id)
```

compared against a null `auth()` and matched nothing. The service returned empty
results and looked broken; the policy was correct. **Which factory you picked
silently decided whether your row policies worked.**

`withLitestoneDb` now does the scoping itself, so both factories get a
caller-scoped client. `createLitestoneService`'s own `$setAuth` is redundant but
harmless, and is kept for apps that seed `ctx.locals.db` by hand.

### The unscoped fallback is now an error

`createBaseService` fell back to `ctx.app.db` and wrapped it with
`adaptPlainClient()`. For a Litestone client that meant running unscoped with no
warning. It fails closed — policies match nothing rather than leaking — but it
looks like broken code rather than misconfiguration. It now throws and names the
fix.

**New:** `tools/check-app-db.mjs` — 10 checks over the option's behaviour,
including anonymous requests, plain clients, and composition with later
`app.hooks()` calls.

## createLitestoneService removed

`index.ts`, `src/core/litestone.ts`, `src/core/service.ts`.

Its last remaining reason to exist was the `schema` option, which is now on
`createBaseService`. There is one service factory.

```ts
createBaseService({ name: 'leads', model: 'lead' })                    // derived
createBaseService({ name: 'leads', model: 'lead', schema: explicit })  // explicit
```

An explicit schema **replaces** the derived validator rather than stacking with
it, and a schema with no usable definition warns and falls back rather than
throwing:

```
✓ explicit schema compiles / enforced / REPLACES derived
✓ gate auth still applies
✓ unusable schema warns, falls back to derived
```

`resolveDefsKey` is exported from `litestone.ts` so the accessor → `$defs` key
mapping has one implementation rather than the guess-at-plurals chain the old
factory used.

**New:** `tools/check-explicit-schema.mjs` (8), replacing the alias checker.

### The old split, for the record

`createBaseService` and `createLitestoneService` were parallel implementations
over the same `createLitestoneBase`. The difference was invisible at the call
site and decided real behaviour — only one scoped with `$setAuth`, only one
validated. None of the three options that seemed to justify the split were
Litestone-specific:

| option | why it was not a blocker |
|---|---|
| `idField` | plain string, already understood by the shared base |
| `softDelete` | documented as *"a Junction-side override… default: trust the schema"* |
| `cache` | `CacheDeclaration` is defined in Junction core, backed by a per-app cache |

No stubs were needed — `createBaseService` simply wasn't passing them through.

**New:** `tools/check-service-options.mjs` (13).

`src/core/service.ts`, `src/core/litestone.ts`.

`createBaseService` and `createLitestoneService` were parallel implementations
over the same `createLitestoneBase`. The difference was invisible at the call
site and decided real behaviour — only one scoped with `$setAuth`, only one
validated. Both are derived from the client now, which left the split with
nothing to justify it except three options.

None of those three were Litestone-specific:

| option | why it was not a blocker |
|---|---|
| `idField` | plain string, already understood by the shared base |
| `softDelete` | documented as *"a Junction-side override… default: trust the schema"* |
| `cache` | `CacheDeclaration` is defined in Junction core, backed by a per-app cache |

So no stubs were needed — `createBaseService` simply wasn't passing them
through. It now accepts all three and carries `_meta` for the manifest and
devtools plugins.

`createLitestoneService` is a 50-line alias. The one asymmetry kept: an explicit
`schema` replaces the derived validator rather than stacking with it, for a
service whose validation should differ from its table definition.

```
✓ softDelete / cache / idField honoured
✓ gate auth still derived
✓ validation still derived
✓ explicit schema enforced — name: name is required
```

## Authentication is derived from @@gate

`src/core/litestone.ts`, `src/core/service.ts`.

A model's `@@gate` already states the minimum level per operation:

```prisma
@@gate("4")        read/create/update/delete all require USER
@@gate("0.4")      read is public; writes require USER
@@gate("2.4.4.5")  read 2, create 4, update 4, delete 5
```

Restating that as `before: { find: [authenticate], get: [authenticate], … }` on
every service is five lines saying what one line already said. Worse, the
per-operation form **cannot** be expressed that way — a public-read model had to
either drop the hooks entirely or reject anonymous reads.

`createBaseService` now installs `gateAuth(model, op)` per method, resolved at
call time:

```
✓ gate 4:       anonymous find rejected, authenticated find passes
✓ gate 0.4:     anonymous find ALLOWED, anonymous create rejected
✓ gate 0.4.4.5: read public, delete needs auth
✓ no gate:      unrestricted
✓ plain client: no-op
```

That is "authenticate by default with public exceptions", declared once in the
schema, per operation.

### Scope: only the anonymous case is derivable

Junction's contribution is the **status code**. The Gate plugin enforces the
level at the data layer, but an anonymous request reaching that far fails as a
policy error, not a 401. This rejects it at the API boundary instead.

Whether an *authenticated* user clears level 4 depends on the app's own
`getLevel()`, which Junction cannot see — so that check stays in the data layer
where it belongs. `gateAuth` only asks "does this operation require a level
above STRANGER, and is anyone logged in?"

### Ordering

Auth runs before validation — rejecting an anonymous request costs less than
parsing its body, and it produces the more useful error:

```
anonymous + invalid data     → 401 Authentication required
authenticated + invalid data → 400 email: email must be a valid email address
```

App hooks still run first, so a service can add its own checks ahead of both.

**New:** `tools/check-gate-auth.mjs` — 11 checks across gate shapes.

## Field validation is derived from the schema, not declared

`src/core/litestone.ts`, `src/core/service.ts`.

`createLitestoneService` accepted a `schema` option and compiled it into
`before.create` / `before.patch` validation hooks. `createBaseService` had no
schema option at all — so which factory you chose silently decided whether your
field rules were enforced, the same trap as the scoping bug above.

Nothing needed to be declared. A Litestone client carries its own parsed schema
on `$schema`, so `@length(1, 200)`, `@email` and `@gte(0)` were already known.
Passing `schema: generateJsonSchema(db.$schema)` to every service was
boilerplate whose only failure mode was forgetting it.

`createBaseService` now installs `autoValidate(model, mode)` hooks that resolve
everything at call time — the client is not known when a service module is
imported. Against the real smoke-test schema:

```
✓ valid data passes
✓ rejects a bad email        — email: email must be a valid email address
✓ rejects a negative value   — value: value must be at least 0
✓ rejects an over-long name  — name: name must be at most 200 characters
✓ plain client: validation no-ops
```

`@frontierjs/litestone` is a peer dependency, so the import is dynamic and its
absence tolerated — the same approach `plugins/manifest` already uses. User
hooks run first, so a `before/create` hook can still shape `ctx.data` before it
is validated.

### The accessor / model-name mismatch is fixed properly

`generateJsonSchema` keys `$defs` by model NAME (`Lead`); services address tables
by accessor (`lead`). `createLitestoneService` used one value for both lookups
and tried `name`, `model`, `name + 's'` — so `{ name: 'leads', model: 'lead' }`
matched none of them, fell through to a `try/catch`, warned, and ran with **no
validation**. Resolution now goes through the schema's own model list, so it
holds for any naming convention rather than guessing at plurals.

### A silent-failure path I introduced, then closed

The dynamic import was originally wrapped in a bare `catch { return null }`.
That is correct when the client is not a Litestone client — but when the client
*does* carry `$schema`, validation was expected, and swallowing the error would
disable field validation app-wide with no signal. It now warns once, naming the
cause.

**New:** `tools/check-auto-validation.mjs` — 6 checks against the real
smoke-test schema.

## Types imported as values broke type-stripping runtimes

`src/transport/http.ts`.

```ts
import { serveStatic, StaticOptions } from './static.ts'
import { createStats, TransportStats } from './types.ts'
```

Both second names are interfaces. Bun transpiles TypeScript fully so it erases
them silently; a runtime that *strips* types instead leaves the import in place,
the target has no such runtime export, and the module fails to instantiate:

```
SyntaxError: The requested module './types.ts' does not provide an export
named 'TransportStats'
```

That is Node's `--experimental-strip-types`, and it is the same rule
TypeScript's own `verbatimModuleSyntax` and `isolatedModules` enforce. Any
consumer outside Bun hits it on import.

Both split into `import type`. **New:** `tools/check-type-imports.mjs` — walks
`src/`, resolves each relative import, and reports names declared only as
`interface` or `type`. Currently clean across 50 files.

## Not changed, but worth knowing

Found while wiring a fullstack app against Litestone and `@frontierjs/auth`.
Neither is Junction's bug alone, but both surface here first:

- **`createLitestoneService` conflates the Litestone accessor with the model
  name.** It derives one value and uses it for two lookups: `createLitestoneBase`
  does `scopedDb[model]`, which needs the accessor (`lead`), while
  `generateJsonSchema` keys `$defs` by `model.name` (`Lead`). Neither value
  satisfies both, and the `$defs` miss doesn't throw — it `console.warn`s and
  drops auto-validation, so a service can silently accept unvalidated input.
  `LitestoneServiceConfig` probably wants the two as separate fields.

- **Auth plugin routes don't inherit `apiPrefix`.** `registerServiceRoutes`
  applies it; plugins calling `app.post()` directly do not. `@frontierjs/auth`
  defaults to prefix `/auth`, but Junction's own browser client hardcodes
  `/api/auth/login` in `authenticate()` — so with defaults on both sides they
  never meet. Apps have to set `prefix: '/api/auth'` explicitly.
