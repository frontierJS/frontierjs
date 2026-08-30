# Changes — @frontierjs/junction

## 2026-08-29 — a detail read that composes is a trigger, not a value

1668 tests, 0 fail, typecheck clean. Ruled as
[`FJS-D161`](../../DECISIONS.md#fjs-d161); closes
[`FJS-533`](../../ISSUES.md#fjs-533).

**`record(id, { composed: true })`.** A node holds ONE shape and `_write`
replaces it, so a screen whose `get()` answers the row PLUS what hangs off it —
an `include:`, a `withWidgets()`, a count assembled per call — showed its
children until the first announcement and then showed none, because a push
carries the row alone. Declaring it makes the node the TRIGGER: the view keeps
its own value, the composed row is never written into the shared node, and any
move of that node re-runs the read, coalesced per burst.

It is declared rather than inferred because nothing in a browser can see what a
service's `get()` composes — that is a server-side shape, and JSON Schema
describes the model rather than the method.

**`changed` re-reads in BOTH modes.** The announcement that names no row — a
bulk write, a `select: false` write — carries a count, so no view can tell
whether this row was in it. The list already re-reads on it; a record view did
not, which made it the one write that left a watched row stale for good.

## 2026-08-30 — a browser can tell it is running the previous deploy

1661 tests, 0 fail, typecheck clean. Phase 3 of
`IDEAS/release-transitions.md`, ruled as
[`FJS-D160`](../../DECISIONS.md#fjs-d160).

**The server states its build; the client compares.** A response header
(`x-fjs-build`) and a field on the socket's `connected` frame — nothing here
reads a build off a request. A server that diffed per call would answer a
question that changes at most once per deploy, on every call, and would have to
be written twice because the two transports carry headers differently.

It rides `connected` rather than a new frame: that frame is sent once per socket,
which is the cadence this needs — a deploy restarts the container, every socket
drops, and the reconnect is when a stale client finds out.

**It is the BUILD and not the Release.** A browser holds the web bundle; a
Release is also an image digest and a schema surface. Two Releases share one
bundle on every API-only deploy, and telling those browsers they are stale is a
reload prompt for a change that cannot reach them.

**Inert unless both sides know their build**, and the header is gated so
`_finalizeWithHeaders`'s no-op fast path survives for every app that never
deployed. `client.stale`, `client.serverBuild`, and a `stale` event that fires
**once** — carrying both ids, so a screen can say which.

`tests/client-types.test.ts` earned its keep: the client imports the wire names,
a client compiles under the APP's tsconfig with no node types, and a bare
`process.env` put `Cannot find name 'process'` into every consuming app —
`FJS-268`'s class, caught before it shipped.

## 2026-08-29 — a service filename derives one name, and keeps answering to the old one

`FJS-570`, ruled `FJS-D159`. A kebab-case service FILENAME was a fourth spelling
of a name Invariant 2 says three resolvers must agree on, and it broke two
resolutions at once: `deriveModelName('product-variants')` singularises to
`product-variant`, which is not the accessor — which is why all six multi-word
services in `example` hand-write `model:` — and Sierra's
`serviceNameFor('ProductVariant')` answered `productVariants`, which matched
nothing, so every relation picker onto a multi-word model offered an empty list.

`deriveName` folds `-` and `_` into camelCase. The file keeps its name; the
service gets one spelling; the filename's own spelling is registered as an
ALIAS, so `/product-variants`, `app.service('product-variants')` and a WS frame
naming it all still resolve. Every lookup already went through
`ServiceRegistry.get`, so one resolution covers HTTP, the socket, `app.service`
and OpenAPI — and both transports now build the context from `service.name`, so
a call arriving under the old spelling announces and resolves its model under
the one name the service has.

A DECLARED name is untouched: `createService({ name: 'hub-config' })` is a
statement, and guessing at one is what this refuses. Every `surface.snapshot.md`
carries the alias as **also answers to**.

## 2026-08-29 — attached services, and the refusal that reaches the operator

1635 tests, 0 fail, typecheck clean. Phase 2 of
`IDEAS/release-transitions.md`, ruled as
[`FJS-D158`](../../DECISIONS.md#fjs-d158).

An app needs things it does not own — an n8n, a mail server, a search cluster —
and nothing here knew that. The dependency was four environment variables
somebody remembered to set, so a missing one surfaced at 3am on the first
request that reached the service, hours after the deploy that caused it.

`attachments` in `junction.config.js` (or `createApp({ config })`) declares what
the app needs; the environment binds it, as the ordinary variables the process
actually has. Not `fli deploy`'s recorded binding set — that is written into the
Release and applied by nobody (`FJS-585`) — which is why the check grades
`process.env`: it holds however the variables arrived. `check-attachments` is a start phase and
refuses to boot on an unbound or half-bound service.

**It is not a second `defineEnv`.** `checkEnvField` is extracted from it and
called by both, so *present, non-empty, a URL, long enough* has one owner
(Invariant 4). What an attachment adds is the three things a flat spec cannot
say: these keys are ONE SERVICE, so the refusal names the service; ALL OR
NOTHING, so `optional: true` forgives a service nobody bound and still refuses
one bound halfway; and A DEFAULTED KEY IS NOT EVIDENCE, or an unbound service
with one default would look half-bound.

**Half-bound is the assertion worth having.** It is what actually reaches
production — somebody binds the URL and forgets the key — and it is exactly what
a per-variable check cannot see, because every individual variable it can name is
either legitimately absent or legitimately set.

**A top-level key in the config file had to be MAPPED or it does nothing.**
`loadConfig` maps `app` and two `middleware` keys onto `AppConfig` and stashes
the rest under `_junction`, so a block nobody looks up is read by nothing —
`FJS-431`'s shape. The mapping is in `loadConfig`, not a fallback read in the
phase, because a fallback is a second answer to where attachments live.

`env.ts` had no tests at all before this; `checkEnvField`'s are the first.

## 2026-08-29 — the backfill, which is the middle step of a split

1581 tests, 0 fail, typecheck clean. `IDEAS/release-transitions.md` § *The hole
in this record*, ruled as [`FJS-D157`](../../DECISIONS.md#fjs-d157).

`litestone release` refuses a contract on a required column and hands back
*expand → backfill → contract*. It grades the two deploys; the middle step was a
sentence sitting between two commands. That is the step that takes hours and the
only one that can fail halfway, and it is not a migration — a migration is a
schema change applied once inside a transaction, and that definition is worth
keeping.

`defineBackfill({ name, model, field, fill })`, a `BackfillRun` row and
`app.configure(backfills([...]))`. Shipped the way the outbox is: a `.lite`
fragment imported by name (`fli backfill:install`), a plugin, and Caravan as the
engine.

**Four of pgroll's five properties come from the shape.** The row is the
checkpoint, the queue makes each chunk durable and retried, and `dispatch({ id })`
keyed on the cursor makes a replay a no-op. The one worth stating: **idempotence
is the predicate, not the cursor** — a chunk re-reads *the column is still null*,
so a row an interrupted chunk already filled is skipped whatever position was
saved. A custom `where` that does not exclude its own writes gives that up, and
the option says so.

**Throttling is the one thing built, and it is a duty cycle**: the gap before the
next chunk is a multiple of what the last one cost, so a backfill that is costing
more stands down in proportion. What it does not measure is said rather than
implied — the signal is this backfill's own latency, so it is blind to load that
does not touch these rows, and `busy_timeout` is a PRAGMA so SQLite swallows the
retries and only wall time is visible from here at all.

**It starts itself.** A backfill that had to be triggered by hand would put a
command between two deploys, and the person running it is the one who has just
deployed the file declaring it. Boot queues the first chunk of anything
unfinished; every replica does that and one row is queued, because the chunk id
carries the cursor.

**The assumption that was wrong, and it is the reason for the shape of the
write.** `announce` is a BULK option — a single `update` has none and always
fires — and `asSystem()` does **not** suppress a `$tapEvents` tap. A system
per-row update announces `update:row` exactly as any other does, so a per-row
backfill over ten million rows broadcasts ten million times. So a chunk groups
its rows by the value the fill answered and issues one
`updateMany({ announce: 'none' })` per group, and the run row's own progress
goes the same way — every write this feature makes is silent, including its own
bookkeeping. The test asserts it with two controls, because *silent* has to be
told apart from *nothing is listening*.

**Two things writing the tests found, and both are the same shape — a failure
that reports success.**

A backfill naming a column the model does not declare would have **marked itself
done having filled nothing**: a `where` with an unknown key warns to stderr and
matches no rows, so the empty first chunk reads as the end. `assertField` refuses
it and lists what the model does declare. Silently finished is the one outcome a
backfill must not have, because a later contract is allowed to rely on it.

And **a paused run could not be resumed**. `dispatch({ id })` treats a taken
primary key as work already queued *for all time*, so the chunk that ran and
declined at the paused cursor holds that id forever and every later dispatch at
that position is a no-op. The recovery sweep had the same hole, which is worse —
restarting a run the queue gave up on is the sweep's whole job. `generation` is a
term of the chunk id now, bumped by a resume and by the sweep's recovery: the
same counter the deploy journal keeps, for the same reason.

**What it is not**: a durable workflow. The record read *the noun arriving twice*
as evidence for a general primitive; the opposite reading is taken — two narrow
mechanisms that look alike are not yet one. Nothing here has steps, compensation,
or a point past which it can only go forward.

**Scope, stated rather than discovered.** One database. Under
`createApp({ tenants })` each tenant has its own rows and its own run row, so a
backfill there is N independent backfills carrying a tenant through the queue —
not built, and refused by name rather than run against the app-level database,
which is nobody's.

The classifier half is `packages/cli`: litestone puts `needsBackfill` on the
finding and `fli release:check` says whether one is declared.

## 2026-08-29 — `busyTimeout` on the SQLite cache

`createSqliteCache({ busyTimeout })` — ms to wait for another process's write
lock before `SQLITE_BUSY`, default 5_000, `0` fails immediately. Only meaningful
for a file-backed cache; in memory there is nothing to contend for.

`createDatabase` needed nothing: its `pragmas: [...]` run after the defaults and
therefore already override the floor, which the pragma list now says out loud.

`FJS-569` closed. The number is a bound on how long one call blocks this
process's event loop, because `bun:sqlite` is synchronous — see
`@frontierjs/litestone`'s `docs/concurrency.md`, and `FJS-D155` for why it is an
option rather than a declaration.

## 2026-08-27 — `app.registerDevService()` — the second listeners the banner could not see

1547 tests, 0 fail, typecheck clean.

The boot banner is derived from MOUNTED ROUTES, and a sidecar has none: a dev
mail catcher, a stand-in payment provider and a dev identity provider are each
their own server on their own port. So the one place an app says what it is
serving was silent about three of the four processes `example` had just started,
and the only record they existed was three hand-written `console.log`s in the
app's entry file — beside a prose row in the repo's port table and a literal in
the sink's own source, none of which is data.

`app.registerDevService({ name, url, note })` is the announcement, keyed by
name, beside `registerMetricsSource` and `registerHealthCheck`. Two readers: the
banner prints one line each, after the app's own line, and `/manifest` carries
`devServices` — the section nothing else in that document could hold, since a
sidecar mounts no route to be listed under.

**Announcing is all it does.** Junction does not start, stop or health-check the
process; the caller already holds the handle it needs to stop it, and a register
implying otherwise would be a supervisor. `_devtools` is the same problem solved
once for one case and stays as it is — it has a *refused* state with a reason,
which an announcement has no way to express.

## 2026-08-26 — `membershipClaim({ capabilities })`, and a standing claim that was a guess

`FJS-D151`. 1541 tests, 0 fail, typecheck clean.

A capability is always per tenant (`FJS-D149`) and the same person holds a
different set in each, so the grant cannot live on the session. It is read off
the membership row — the row the standing already comes from, so it costs no
second query — and emitted as `auth().capabilities`, which is the one claim name
this framework fixes rather than the app: litestone's grid reads that name, so
what an app chooses is which COLUMN it comes from.

Absent and empty are the same answer and both are legitimate; a column that is
not a list is neither, and is refused by name rather than coerced into an empty
set that reads as a caller holding nothing.

**A standing's claim name was read off the end of `claims`**, which was the
standing only while a resolver emitted exactly two. The third claim took the
label the moment one existed, and basecamp's snapshot said the grant column was
*read from `WorkspaceMember.role`*. `describe()` states `standingClaim` now.
`principal.snapshot.md` gains a `Capability grants` row and names the grant claim
for what it is.

## 2026-08-26 — no browser had ever uploaded a file

`FJS-542`. 1541 tests, 0 fail.

`parseBody` lowercased the whole `content-type` header and then read the
multipart boundary out of that copy. The media type is case-insensitive and its
PARAMETERS are not — RFC 2046 §5.1.1 says so about this parameter by name — so
the boundary handed to the splitter did not match the one in the body. No part
was found, `data` was `{}`, and the request answered **`Request body is
required` about a request that plainly has one**.

Chrome and Safari send `----WebKitFormBoundary…`. Firefox sends dashes and
digits. So this is every browser, and it is every file any browser has ever
tried to upload to a Junction app.

**Every probe of the path passed.** curl, Bun's own `new Request({ body: form })`
and undici all generate lowercase-hex boundaries, and the one existing multipart
test asserted the parsed body's TYPE and never its contents. It was found by
putting a real file input in a real browser, and nothing short of that would
have found it.

Two values now — the raw header for parameter values, a lowercased copy for
comparing the type — plus quote-stripping, which a boundary holding a space or a
comma requires. `tests/multipart-boundary.test.ts`, negative-controlled.


## 2026-08-26 — where an app's services are, probed rather than derived

`FJS-458`. 1526 tests, 0 fail; typecheck clean.

The autoload default resolved `dirname(Bun.main)/services` — the FLAT layout,
entry and services as siblings. The layout this framework documents and
scaffolds puts the entry at `api/index.ts` and the services at
`api/src/services`, so the default named `api/services`, which is not there.
Nothing fails: `autoloadServices` is not called, the app boots, `/health`
answers, and every route those services would have mounted is a 404. Measured
on `example` while moving it to the canonical layout — the boot line went from
`services=12` to `services=3`, the three auth registers, and the only symptom
was one URL that did not answer.

`resolveServicesDir` is the one owner of the answer now, and it PROBES:
`./services`, then `./src/services`, beside the entry, first one that exists.
Both layouts, and an entry that has moved to `api/src/app.ts`, all resolve
without the app saying anything. Nothing in it knows an app has an `api/`
directory — that is the app's shape, not junction's — so a cwd-relative
candidate is deliberately absent: that is how you pick up somebody else's
directory when a command is run from the wrong place.

**A declared directory is never probed around.** `services: { dir }` or
`createApp({ autoload })` naming a directory that is not there is reported by
name, loudly, wherever it happens — including in a test, because the app is the
thing that stated it. Falling back to a probe would hide the case this is most
likely to be: a relative path resolved against the wrong working directory,
which lands on nothing and looks exactly like an app with no services.

**And the miss is visible.** The boot banner carries `autoload=` — the directory
that answered, or the candidates that did not:

    services=20 autoload=api/src/services
    services=3  autoload="none — probed api/services, api/src/services"

A field rather than a warning. An app that registers its services by hand is
not doing anything wrong, and a framework that shouts at a correct app teaches
everyone to stop reading; `services=3` beside `autoload=none — probed …` says
what a warning would have said, on the line people already read at boot.

**The snapshot tools ask the same question.** `junction surface|jobs|principal`
had to be handed `--services` because the app's own phase resolves against
`Bun.main`, which when they run is the tool — so an app whose services are all
autoloaded described as empty unless somebody remembered a flag. They now ask
`resolveServicesDir` with the app MODULE named as the entry. `--services` is an
override, and a directory named there and absent is fatal rather than skipped.

**`build:app`'s bundling guard was the fourth caller and had its own copy**, so
it checked `<entry>/services` while the app scanned somewhere else. On a
canonical-layout app that meant the guard found nothing, downgraded its ERROR to
a warning, and shipped a bundle that boots clean and 404s every route — the same
failure one level up. It asks the resolver now, which is why the rule lives in
`core/services-dir.ts` with node builtins and nothing else: `build:app` is a
build script that imports none of the runtime.

`example` dropped its `services: { dir }` declaration and boots with 20 services
on the default; `basecamp` keeps its absolute `autoload:` for the reason that
has nothing to do with layout — under `bun test` the entry is the test file.
`fli new` keeps writing the declaration: it is a true statement, and it is the
only form that also works against the published junction.

## 2026-08-29 — the sqlite cache waits like everything else

`FJS-569`'s junction half, and it is one line. `storage/database` already set
`busy_timeout = 5000`; `createSqliteCache` was the one connection in the package
without it, so a file-backed cache shared with a second process failed
immediately instead of waiting. Harmless in memory, where there is nothing to
contend for.

## 2026-08-26 — `remove` declines `$withDeleted` by name

`FJS-523`'s remaining half, and the change is what it SAYS rather than what it does.

`remove` never honoured the directive and does not start now: against an already-deleted
row the only action left is to destroy it, which is the one write that defeats
`@@softDelete`. A directive on the ordinary DELETE would hand that to every caller who
may remove a row — no separate permission to grade, no way back — so what a model
declares recoverable would be recoverable until somebody put six characters on a URL.

What was wrong is that it refused with a **404 naming the row**. The row is plainly
there; the answer reads as *it is gone* rather than as *the flag is declined*, which is
how the whole hole stayed invisible for as long as it did. It is a 400 naming
`$withDeleted` and pointing at the patch that DOES free a `@unique` value.

Two things are deliberate. It is graded on the **request**, never on the row's state —
the same call must not succeed or refuse depending on data the caller cannot see. And
it is silent on a model with no `@@softDelete`, where `remove` is already the hard
delete the directive is asking about and there is nothing to decline.

**Whether the model soft-deletes is ASKED** — `db.$softDelete` through
`modelSoftDeletes`, memoised per client, keyed through `accessorCandidates` like every
other name that crosses this boundary. Deriving it here would be a second reading of
`@@softDelete`, and two readings drift. `in` rather than a bare read, so a Litestone
older than the capability answers `false` and degrades to the previous behaviour instead
of exploding — which is also how it found `FJS-536`.

11 tests against a real Litestone client, with a model that hides nothing as the
negative control.

## 2026-08-26 — `findWindow`: the window is one function, and the page is walked in the order the cursor resumes in

Two things, and the second is a defect the first exposed.

**`findWindow(table, args, after, label)` is now the one owner of both paths a
list read can take** — an ordinary page with the far edge minted off its last
row, or a keyset scan resuming from an edge — and it is exported, because the
derived find is not the only find. A service that assembles its own query (one
forcing a tenant column, one narrowing to the filters it means to expose) had
no way to answer `$after` short of restating both branches, and a restatement is
how the tiebreaker, the absent `total` and the *a cursor and an offset never
combine* rule end up with two answers. basecamp's audit trail is the first
caller outside junction.

**Then: a tie across the edge lost rows** (`FJS-535`). The page was ordered by
the CALLER's `orderBy` and the cursor minted in the TOTAL order — the caller's
plus the tiebreaker litestone appends — so where two rows tie on every sort key
the page stopped wherever SQLite happened to stop while the edge named where the
total order says it stopped. The rows in between were never served and the list
reported itself complete.

It is invisible in a fixture built one row at a time: an ordering only goes
partial on a tie, and a tie on `createdAt` is a burst of writes inside one
millisecond — the ordinary case for anything a hook writes. The existing
non-unique walk in `tests/window.test.ts` passed because it ordered ASCENDING
over sequential ids, where SQLite's own order and the total order agree by
accident. It took building the thing: basecamp's audit trail, five rows sharing
one timestamp across the 50-row edge, two of them gone.

`table.orderTotal(orderBy)` is asked for the ordering and used for the page's
`ORDER BY` and the cursor alike. **A list that cannot be totally ordered now
carries no edge rather than a wrong one** — the read is still answered, because
a read is not a request for a window, and `endCursor` is `null` so nothing asks
for a position that cannot be named.

## 2026-08-26 — the suite is green on a full run

`tests/heartbeat.test.ts` § *holds a connection that answers the ping* asserted
`app.channels.stats().connections` is 1 and found 2 on every full run, passing in
isolation — one red on `bun run test` for as long as it existed, and
`knownTestFailures` carried no entry, so the tests phase was red for everyone.

**It was not a decision about what the heartbeat guarantees**, which is why it
sat filed. Both halves were already asserted, by the cases that can make them:
*evicts a connection that answers nothing* checks `connections === 0`, which is
what eviction means and is about the socket under test; *holds a connection*
checks `c.closed` on the line above, which is what holding means. The count
beside it was a third claim — **no other test's socket exists** — that a case
owning one connection cannot make, and that would be wrong in principle on a run
where it passed.

`toBeGreaterThan(0)`. The connection is counted; it does not claim to be alone.

1513 pass, 0 fail, three consecutive full runs. `FJS-516`.

## 2026-08-26 — `app.db` can be typed

`App.db` was `unknown`. Honest — junction genuinely does not know what the
client is, since a Litestone client and a plain table-shaped object are both
valid and `createBaseService` adapts the latter — and unusable, because an app
cannot narrow it: Invariant 5 rules that a property is typed by AUGMENTING an
exported interface and never by redeclaring it, declaration merging requiring
identical types so a redeclaration silently loses.

**Junction had already solved this three times and `db` was the one that missed
it.** `AppConduit`, `AppJobs` and `AppNotify` are each an empty interface a
package augments, carrying the note *empty here on purpose … augment it, don't
redeclare*. `AppDb` is the fourth, and here the augmenter is usually the APP
rather than a package, which changes nothing about how it works.

The cost of not having it was measurable: basecamp claimed a SECOND runtime name
for the identical object — `app.claim('data', db)` — and read `app.data` 29
times against `app.db`'s three, two names for one owner reached by obeying
Invariant 5's letter (`FJS-532`).

**The option stays `unknown` and the field is `AppDb`**, with one cast where they
meet. Narrowing the option too would mean an app that augments could no longer
pass the plain object `createBaseService` adapts — permissive in, typed out.

## 2026-08-26 — `$after`: a live list grows a window instead of stepping through pages (`FJS-D145`)

Offset paging is correct for a static table and silently wrong for a moving
one — rows shift between page 1 and page 2, so one item is shown twice and
another is never shown at all — and it sat worst beside this framework's best
feature, a `channel:` subscription pushing rows into a store that pages by
position.

**`$after` is the window's far edge**, one row in
`@frontierjs/toolbelt/directives`, so both transports carry it from one change
and the bridge strips it from the filters like any other directive. A caller
sending it is on the keyset path: no OFFSET, no COUNT, and `total` is `null`
rather than guessed, because reporting the page length as the total is what
makes a list claim to be complete every time it is capped.

**An ordinary page carries the edge too**, minted from the last row it already
holds — `endCursor` and `hasMore` on the list envelope. No second query, so a
caller that never grows a window pays nothing for one. The tiebreaker is
**asked of the table** (`cursorFor`) rather than derived here: it is the
schema's, and two answers to it would name a position the next page does not
resume from.

**On the client, `resource().more()`** grows the window and `hasMore()` asks
whether there is anything past it. It appends rather than places — the server
answered in the window's own order and a keyset slice sorts after everything
already in it — and `limit` grows with the window so the trim that guards page 1
does not cut off what was just fetched. Growing is **not a chance to ask a
different question**: the query and the directives are the last `load()`'s,
because a cursor minted under one ordering names no position in another. It
takes the same stamp a `load()` does, so a reload during a `more()` supersedes
the slice instead of mixing two windows.

One thing fell out of the entity keying: **a list is a set of ids in an order,
so one row cannot be in it twice.** Growing a window is where that shows — the
server resumes from the edge, but a row can arrive on the socket in between and
be in both the list and the slice.

14 cases in `tests/window.test.ts`, including a walk over a **non-unique**
ordering through a real request. Green: 1509 tests, typecheck clean.

## 2026-08-26 — `config.mail`, so a from-address can be a tenant's

`AppConfig` gains an optional `mail: { from?, replyTo? }`.

A from-address is the canonical per-tenant value (`FJS-D126`) — one deployment
serving several customers has one of these per customer, printed on every
receipt — and until now it existed only inside a mail adapter's own constructor
options, where it is captured once and cannot vary per call. An adapter still
takes its own `from` for an app that has one; this is the floor a tenant
overrides.

`example` is the first consumer, and the shape is worth reading before writing
one: `createConduitMailer` resolves it per SEND through `app.configFor()` rather
than destructuring it at construction, which is the one line that separates a
fleet from a single deployment.

## 2026-08-26 — a write may name a soft-deleted row, so a held `@unique` value can be released (`FJS-523`)

`SoftDeletedUniqueError` is a 409 telling a caller their value is held by a row
they cannot see, and litestone's documented way out is to move the value aside:
`update({ …, withDeleted: true })`. Every READ passed `$withDeleted` through and
no WRITE did, so the escape hatch the refusal points AT was unreachable through
a service — there was no request an app could make that freed the reference.

`update` and `patch` **by id** read it now, through `writeWhere(q)`, which is the
one place the filter is lifted. The default stays fail-closed: the same request
without the directive is still a 404. It lifts on both paths — litestone's own
filter and the `softDelete:` service override — or the directive would work on
one kind of service and not the other.

A **bulk** patch deliberately does not. `bulkByRow` counts and selects its
targets through `table.count`/`findMany`, which apply litestone's filter, so
widening the WHERE alone would match nothing and read as the directive being
ignored. **`remove` does not either**, and that half stays open: against an
already-deleted row the only remaining action is to stop keeping it, which is a
hard delete, and giving `DELETE ?$withDeleted=true` that meaning is a decision
rather than a passthrough. It is asserted as still refused, so making it work is
deliberate.

Found by `example` declaring `@@softDelete` on `Order`: its drive's
stale-reference sweep stopped working, so it passed once per seed and then
reported *the create page is broken*.

## 2026-08-25 — a tenant carries configuration (`FJS-D126`, ruled and built)

The source half. `createApp({ tenantConfig, tenantConfigKeys })` — a resolver
answering a plain object per tenant id, memoised, over `app.config` as the floor.

```js
createApp({
  tenantConfig:     id => db.asSystem().tenantSettings.findUnique({ where: { id } }),
  tenantConfigKeys: ['name', 'mail.from', 'branding.logo'],
})
```

A resolver rather than a declaration, on `FJS-D113`'s ground: the source is a row
for one app, a file for another and a control plane for a third.

**The resolve happens where the tenant is already resolved.** `$.config` is a
property read and a resolver that reads a row is async; they cannot meet at the
point of use without making every reader `await`, which throws away the read shape
shipped last change. So the around hook that establishes `ctx.locals.tenantId`
warms the store before anything downstream runs — the same place `applyClaims`
resolves the principal rather than at the point some policy needs it — and
`runAs` warms it too, because a job is the caller most likely to need a tenant's
from-address and least likely to have a request behind it.

A resolver that throws **fails the call**. Serving the floor instead is one
tenant's mail going out under another tenant's name, silently.

**`tenantConfigKeys` is required, and the reserved set is refused at boot.**
`port`, `host`, `database`, `http`, `auth`, `apiPrefix`, `logging` — a database
path handed to a tenant is every other tenant's rows one typo away, and the rest
are read at boot with no tenant in scope, so a per-tenant answer would be written
and never read. Boot-time, because a per-request refusal is a production incident
and a boot-time one is a failed start.

A key the resolver answers that the list does not name is **refused by name, not
dropped**: a dropped key is a tenant whose configuration silently does not apply,
which arrives as a support ticket reading *the feature is broken*.

Memoised per tenant, holding the **promise** rather than the value, so two
requests for one tenant arriving together resolve once. `invalidateTenantConfig(id?)`
is the explicit way out — a memo with none is a config change that needs a
restart. A **failed** resolve is deliberately not memoised: the row it reads may
be a second from existing.

The floor is never mutated. Every tenant's config is a fresh object with the
allowed paths written over a structural copy, so `app.config` still answers what
the process was started with and the next tenant is not the previous one.

**The allow-list is committed.** `principal.snapshot.md` § Per-tenant
configuration renders it path by path — the section phase two reserved, now
filled. Laravel's `storage_to_config_map` is the shape and the field
confirmation; what is added here is that the list is a reviewable diff rather
than a line in a config file nothing compares. It is the half that makes the
feature safe rather than the half that makes it work, which is exactly why it is
the half worth diffing.

An app that installs no resolver is unchanged in every respect, and the snapshot
says so in words rather than with an empty table.

31 tests, junction typecheck clean at its 0 baseline.

## 2026-08-25 — configuration read at CALL scope (`FJS-D126`, the read half)

Everything an app is configured with resolves once, at boot, and is the same for
every caller for the life of the process. Correct for a port and a database path;
wrong for the half of *theirs* a tenant sees — a from-address, a bucket, a
timezone, a locale, a branding value, a rate limit (`FJS-385`).

**The read moves now and the source does not.** `$.config` off the ambient call,
`app.configFor(tenant)` where there is no call, both through one owner
(`core/config-scope.ts`) that answers `app.config` for every tenant, identically.
Nothing an app does today changes. Adopting it is a statement about WHEN a value
is read and none at all about what it is.

Doing it in this order is the whole point. A boundary move under a live feature
means finding every reader again; the same move under no feature costs nothing.

**Never a rebind, and that is the one rule.** Every mature implementation reached
for the container instead — Laravel's tenancy bootstrappers rebind `config()` per
request and pay for it with a standing rule that every singleton must capture the
central value in its constructor, because after `bootstrap()` the original is
unreachable; Django states the same lesson as a prohibition; NestJS documents that
a request-scoped provider silently makes every dependent one request-scoped, and
its own docs point at AsyncLocalStorage. Junction already has the ALS, so what
all three pay for is free here — provided the view cannot be written, since a
writable view is that rebind wearing a different word. So the view is read-only
**deep**: the shallow version refuses `$.config.name = x` and admits
`$.config.http.cors.origin = x`, which is the same defect one level down and the
one somebody actually writes. `app.config` itself stays writable, because
`loadConfig` merges into it at boot.

The refusal names the ways in — `junction.config.js`, `createApp({ config })`,
and the tenant's own config once `FJS-D126` is ruled — because a read-only error
with no next step is a dead end.

`$.config` joins `$.db` and `$.me` as a derived accessor: absent from `ownKeys`,
so `{ ...$ }` does not evaluate it, present in `in`. Refused outside a call like
the rest of `$`; `app.configFor()` is the answer for a job, a raw route or a
script.

Migrated: `collectHealth` and `collectMetrics`, which build a body per request and
read the app's own NAME — exactly the shape a tenant varies. `configFor` rather
than `$.config` there because a health route is a raw route and holds no service
call.

**What the survey found, and it is better news than the plan assumed.** Of the 25
`AppConfig` reads inside this package, almost all are boot-scope and correctly so
— ports, `database.url`, helmet, CORS, `maxBodySize`, `drainTimeout`,
`http.callHeaders` — and every one of them is on the deny half of the allow-list a
ruling will need. The expensive re-plumb is not in junction. It is in the
closures an app and a provider capture: `createResendMailer(opts)` destructures
its default from-address at construction, which stays boot-scope until there is a
config key for it to read, and that key is `FJS-D126`'s business rather than this
change's.

14 tests. Junction's suite is currently flaky in `tests/heartbeat.test.ts` under
concurrent edits to `transport/channels.ts` — untouched here, and it passes run
alone.

## 2026-08-25 — one node per row: a list is a VIEW, and a detail screen is live (`FJS-518`, `FJS-D138`)

**A row read with `service.get(id)` was a plain object no announcement could
reach**, so every detail screen in this repo went stale the moment somebody
else wrote the row. The store was also per-`resource()` call and held whole
rows, so two `createResource('orders')` in two route files were two copies kept
in step only because both happened to subscribe to the same service.

`src/client/nodes.ts` is the registry. One node per row, keyed by MODEL — two
services over one model are one row, and the name is passed in because this
package holds no schema, the same reason `match` is. **The id is normalised
into the key**: a list holds `{ id: 5 }` and a detail screen is reached by a URL
carrying `'5'`, and two nodes there means a push moves exactly one of them.
Identity rather than filtering, which is what makes `String(id)` right here and
wrong in a query string (`FJS-D125`).

**`Store` is a view.** Bound, it holds ids and materialises through the
registry; `get()` still answers rows, so no screen changed — `useStore` is the
one bridge to a Mesa signal and nothing in either app calls `subscribe` or
`get` directly. Every mutator still works on a materialised array, so the
membership and placement rules are the same lines they were and
`live-order.test.ts` is the negative control for them. **Unbound it is exactly
what it was**, which is not a shim: a `Store` is constructible alone and the
fifteen cases in `client.test.ts` are what those rules were written against.

**Lifetime is a TTL** — `createJunctionClient({ nodeTtlMs })`, default 30s, `0`
drops at once. Apollo and Relay both ship `retain`/`release` and it is the
most-complained-about part of either; a lifetime the application has to
remember is a leak with extra steps. It also makes list → detail → back warm
for free. The sweeper is armed on the first release and cleared the moment the
registry empties, because a live interval is a test run that never exits.

**`resource.record(id)`** is a view of one over the same nodes — sugar rather
than a second mechanism, which is the shape Meteor's cursors, Convex and Zero
all arrived at. It reads only when nothing has read the row yet, and
`RecordOptions.load` is how Sierra puts its own `_call('get')` there so the
resource's hooks and the `@version` it must hand back come from one place.

Two rules that are less obvious than they look. **A node write is skipped when
the value is the same object** — a push writes the node on arrival so a view
holding no list still hears it, and the list it lands in writes it back through
while assembling itself; without this a watcher heard every push twice.
**"Gone" is the record view's own state and never the node's** — clearing the
shared node would shorten every list holding the row *before* that list ran its
own removal accounting, and two resources over one service share a proxy, so
whichever handler runs second reads a list the first has already changed.

**The overlay is the fourth thing the ruling names, and it landed with the
rest.** `resource.mutate(id, intent, run)` applies a submitted mutation on top
of the truth, runs the write and takes it back if the write fails — the truth
never moved, so dropping the intent IS the rollback. It lives on the node, so
every view of the row moves at once and an intent that changes a sort key
re-places the row in an ordered list with nothing taught about it. What is
stored is the INTENT — a partial, or `null` for a removal — and never the value
it produced; that costs nothing now and is what a rebase would replay.

**Settled against the MUTATION, not the row.** A second writer patching the
same row while this is in flight moves the truth underneath and the intent
stays on top of it, so a rollback reveals what THEY did rather than what was on
screen when this started. Both are asserted.

One consequence worth knowing: `Store._replace` now writes a row back as truth
only when it did not come from the node itself. Every mutator here works on a
materialised array, so most of what it hands back is this store's own view —
and once a node carries an unconfirmed mutation, writing that view back would
commit the optimistic value as if the server had sent it.

28 cases in `tests/nodes.test.ts`. Green: 1490 tests, typecheck clean.

## 2026-08-25 — the principal, committed (`FJS-514`)

**`db/access.snapshot.md` commits the tenancy predicate and the `snapshots` CI
phase fails a stale one. Nothing committed the predicate's INPUT.** Who emits
`auth().workspaceId`, off which part of the request, verified against which model
and column — none of it was in any committed file, so a resolver emitting the
WRONG tenant left every artefact byte-identical, CI green, and every read
answering somebody else's rows.

`junction principal --app <module>` writes `principal.snapshot.md` at the app
root, read off a BUILT app for the same reason `junction surface` is: a resolver
is wired in application code and no file tree can answer which one an app ended
up with. It names its own generator in its header, so the `snapshots` phase reruns
it with no CI edit.

Seven sections — tenancy · resolver · claims · standing · what the rules reach ·
refusals · **per-tenant configuration, which is empty because `FJS-D126` is
unruled**. That last section exists before the feature does on purpose: *which
keys a tenant may override* is the fact that decides whether the arrangement is
safe, and it should land as a diff in a file people already read rather than as a
new face.

`membershipClaim()` now describes itself — `{ kind, model, subject, tenant,
standing, claims, include, namedBy }` — and the return type says so, so a caller
reads it without a cast. A resolver is a function, and *the app has one called
membershipClaim* is not the fact worth committing; which model proves membership
and what the claims are called is. A hand-written resolver may carry a `describe`
of its own and is otherwise reported by name, honestly.

**Names, never values.** A claim's name is a fact about the application; a claim's
value is a caller. `tenantFrom` is excluded for being a function; `namedBy` is
included for being a constant, and once a resolver is installed it is the only
static answer to *how does a request name its tenant*.

Two things it got wrong before it was run against a real app, both about saying
something false rather than saying nothing. It asked `app.db` for the declaration,
which under `createApp({ tenants })` does not exist — a client is per request —
so it reported *no tenancy* about an app that is nothing but; the registry is
parked under a symbol beside the resolver and answers instead. And it rendered a
`bearer` resolver as a membership one with five blank cells and its claim as a
standing, which reads as a resolver that forgot to verify rather than one that has
nothing to verify.

Deliberately absent: the **value→level mapping**. `getLevel` is a function an app
hands to `GatePlugin` and a client answers plugin names rather than instances. The
standing column and its declared enum values are here because a diff can grade
those — a value added to the ladder and not to `getLevel` is a caller silently
graded at the default — and the mapping itself is executed by litestone's
`verifyGateLadder`. A second guessed answer to a question that already has an
executed one is worse than a gap.

Committed for both apps: `example` (`strategy database`, a `bearer` resolver) and
`packages/basecamp` (`strategy row`, `membershipClaim` — 17 scoped by column, 14
by delegation, 14 exempt, which is the same split litestone's
`verifyTenantIsolation` reaches independently).

11 tests. Junction's own suite is currently flaky in `tests/heartbeat.test.ts`
under concurrent edits to `transport/channels.ts`; that file is untouched here and
the failure does not reproduce running the file alone.

## 2026-08-26 — the server lets go of its sockets, and stops in 2ms

`FJS-460`. 1418 tests (`FJS-516` is one red and predates this).

`stop()` raced Bun's graceful `server.stop()` against `drainTimeout` and closed
nothing. **Bun's graceful stop never resolves once a WebSocket has been
upgraded** — measured against a bare `Bun.serve`, not inferred: not after the
socket is closed, not after the server's own close handler has run and the
client reads `readyState 3`.

So the race always ended on the timer. Every shutdown that had ever held a
client cost the full five seconds, and then logged *Shutdown complete* with that
client still at `readyState 1`, told nothing. A suite whose `afterAll` is that
call outlived bun's 5s hook limit four runs in five; an app meets the same thing
as a container that will not stop and is SIGKILLed.

The waits are junction's own now, and neither is Bun's promise. `HttpTransport`
keeps the set of sockets it has open — **at the transport**, because a socket
belongs to it rather than to the channels plugin, so an app's own
`app.http.ws(...)` route is covered by the same code — and `stop(drainMs)` says
goodbye to each, waits for the close handshakes and any in-flight request
bounded by the drain, then stops by force. **5002ms → 2ms**, with the client
reading a clean close.

**The close code is 1012 Service Restart, not 1001 Going Away.** 1001 is the
code that means this, and it is the one code that does not survive: sent as
1001 it reaches the peer as **1000**, while 1012 and a private 4001 arrive
unchanged. Pinned, so a Bun release that fixes it turns the test red and says
so.

The drain still does its job in both directions — an in-flight request finishes,
and one that never finishes is given `drainTimeout` and no more. Both are
assertions rather than notes, because a shutdown that closed sockets promptly
and cut a request off mid-answer would trade one defect for a worse one.

One claim in the report did not survive contact: the port was released promptly
even before the fix. A graceful stop stops ACCEPTING at once, and only its
promise is the part that hangs.

7 tests in `tests/shutdown.test.ts`, timings included — a test that only
asserted `stop()` resolves passed before the fix as well.

## 2026-08-25 — a `readOnly` column with a default made its model uncreatable

**A create was refused by name for a key the caller never sent** (`FJS-504`).
`validate()` fills a default in for any absent key, and
`jsonSchemaToJunctionSchema` carried every property's `default` in create mode.
Litestone marks `readOnly` on exactly the columns a caller may not write —
`@system`, a tenancy-stamped column, `@version`, `@from`, `@derived` — and
several of those carry a `@default` as well.

So the payload reaching the Data boundary named a `@system` column, and
`@system` is refused BY NAME rather than dropped:

    POST /api/discounts {"code":"WELCOME10","label":"…","kind":"percent","value":10}
    → 403  Discount: "redemptions" is @system …

quoting a column the request did not contain. **There was no way out at the call
site**: naming it in `system: [...]` is the opposite of what was meant, and there
was nothing to omit. Measured on both sides — the identical create through a
Litestone client directly succeeded and stamped `redemptions = 0`.

**The sibling had been fixed and the rule stopped one line short.** `mode ===
'update'` already deleted every default, for the same reason a patch must not
invent a value for an absent key; the create half needed the narrower version:
drop the default where the column is `readOnly`, on either mode. Nothing is
lost, which is what makes it safe — the default is declared in the seed and
Litestone applies it at the write, which is where a default a caller may not
override belongs anyway. A value the caller DOES send still travels, which
`@version` requires.

Found declaring `redemptions Int @default(0) @system` on `example`'s new
`Discount`; the shape has been reachable since `@system` existed. Two cases in
`tests/patch-defaults.test.ts`, beside the patch ones. Green: 1412.

## 2026-08-25 — sign-in worked for everyone except a browser on another origin

**CORS never reached a route registered before it** (`FJS-496`). `cors()` patches
the router's registration methods, so it covers every route registered AFTER it.
Nothing said what happens to the ones registered before — and every raw route a
plugin mounts is one of those, because `configure()` runs `register()`
synchronously and the `cors` start phase is much later. Service routes are
registered in a later start phase and were fine.

`/auth/login` was not. Neither was caravan's `/jobs`, nor any `app.post` an app
writes at module scope. **So establishing a session was the one call in a
Junction app that no cross-origin browser could make** — and it does not present
as a CORS problem from either end: the preflight answers 204, the POST answers
200 and creates the session, and the browser throws the response away. What
reaches the page is `Failed to fetch`.

`Router.prependMiddleware(mw)` puts it in front of what is already registered;
patching still handles what is still to come. Two tests: a route registered
before `cors()` gets the header, and one registered after is not double-wrapped.

Found building a storefront account in `example`, where the sign-in island is
served from a different origin than the API — which is the ordinary shape of a
marketing site, a separate front-end deployment, or any app whose UI and API do
not share a host.
## 2026-08-24 — four things `strategy database` needed and none of them existed

1408 tests, 0 fail, typecheck clean. `example` became a fleet of shops — one
SQLite file each, `resolve subdomain`, people per shop — and adopting it found
four gaps in a row. Every one is a seam that worked under `strategy row` and
under one database, and did nothing under this one.

**`verifySession` is resolved before any hook.** So is the tenant, in the sense
that it is not: `withTenantDb` is a hook and the transport authenticates ahead
of it. A provider handed a bare token cannot know which tenant's people it is
being asked about, and under this strategy `User`, `Credential` and `Session`
are rows in the tenant's file. `verifySession(token, from?: CredentialOrigin)`
carries the request's host and headers now — the two things `resolve subdomain`
and `resolve header(…)` read. Optional; every existing provider ignores it
(`FJS-487`).

**A raw route ran outside the request scope.** `enterRequest` has one owner and
five entry points, and the HTTP one is the SERVICE dispatch handler — so
`requestMeta()` was `undefined` inside `/auth/login`, inside a webhook, inside
every route an app or a plugin mounts. Everything that reads the request without
holding a `ctx` was blind exactly there. The `app.get`/`app.post` shortcuts wrap
their handler now (`FJS-488`).

**`announceDataWrites` was not installed for a tenant registry**, which the code
said out loud and which is `FJS-010` all over again: a job writing with
`asSystem()`, a signed webhook moving a row, a bulk write — none of them reached
an open tab. The tap goes on each tenant's client the first time `withTenantDb`
opens it, once per client (`FJS-489`).

**The principal resolver skipped anonymous callers.** `withLitestoneDb` runs it
for a guest and explains why — a cart token is a claim and the population that
needs one has no `auth().id`. `withTenantDb` kept `if (principal && ctx.auth?.user)`.
Two hooks, one seam, one of them fixed: every basket call in `example` answered
404 to every shopper the hour it adopted tenancy (`FJS-490`).

## 2026-08-24 — `client.auth.providers()`

1407 tests, 0 fail (+4). The browser half of `@frontierjs/auth`'s new
`GET /auth/oauth`: which providers this app is configured for, in declaration
order.

A sign-in screen is a separate build from the API, so any list of buttons it
draws is a second copy of the server's own configuration with nothing to fail
when the two disagree. Sent with `skipAuth` — the page that asks has no session
yet, and a stale token in storage must not turn a public list into a 401. `[]`
for an app with no OAuth, which is an answer rather than a failure.


## 2026-08-23 — the webhook signer joins the one definition, and a secret with no reader goes

1399 tests, 0 fail. Two things that had drifted apart from what the repo already
decided.

**The webhooks plugin signed `${timestamp}.${body}`** (`FJS-472`), where
`@frontierjs/toolbelt/signature`'s own header names this delivery path as one of
the three signers it exists to unify. The drift was not cosmetic: that string
binds neither the METHOD nor the PATH, so a captured signature replays against
any other endpoint on a receiver trusting the same secret, and it carries no
NONCE, so a repeat inside the freshness window is indistinguishable from a first
delivery. A subscriber can add neither from its side. It signs the canonical
string now, under its own `X-Webhook` prefix — which is what the prefix
parameter is for: the string is shared, the spelling on the wire stays the
product's.

**The nonce is per ATTEMPT and that is the substance.** This plugin retries a
delivery up to six times, so a nonce reused across attempts would make every
legitimate retry look like a replay and dead-letter it against exactly the
receivers that implemented replay protection properly. The event's identity is
`x-webhook-id`, stable across attempts, and is what a receiver deduplicates on.
Two mechanisms, two lifetimes — the separation `verify:pay` already had to make.
The tests VERIFY now rather than recomputing the HMAC, which is the whole point
of one definition: a path swapped under a real signature, a body swapped under
one, a clock an hour out, and a retry proving its nonce moved while its id did
not.

**`AUTH_SECRET` is gone from what junction generates and grades** (`FJS-360`).
The generated `config/default.ts` wrote an `auth: { secret }` block `AppConfig`
does not declare, into the one file people copy from; the doctor failed apps
that did not have one and told them to add the key junction ignores. It grades
`ENCRYPTION_KEY` now — the credential this stack does have — including the trap
that litestone parses it as HEX, so 64 characters is 32 bytes and non-hex
padding decodes short with an error that reads like a litestone bug. Absent is
NOT graded: an app with no encrypted column legitimately has none, and a rule
that over-fires costs more than one that is missing. The name-based soft warning
in `defineEnv` stays and now says why it is there.

**A taken `@unique` value is a 409 with a field on it**, from litestone's side of
the boundary (`FJS-441`) — `tests/unique-conflict.test.ts` measures what reaches
a browser through a real client, including that no response body contains
`UNIQUE constraint failed` or the physical table name.

## 2026-08-23 — the app could not run its own deferred work

`runAs(null, …)` is *nobody asked* and resolves to `createApp({ system })`.
*The app asked* reaches the same principal by id, and every non-null id went
through `IAuth.sessionFor` — which for that principal can never answer, because
it is deliberately not a row anything can log in as (`FJS-467`).

So anything enqueued while the app's own principal was in scope recorded an id
no re-resolution could satisfy. Measured on `example`'s payment webhook: every
`announce-payment` the settlement queued burned its full retry ladder on *no
such principal… deleted, or disabled* — the app saying its own name and being
told it had been deleted. The drive was green throughout, because it asserted
the outbox row existed and never that the job ran.

Matched before the lookup, against the id the app itself supplied. That is not
the fallback the surrounding code refuses: falling back to `system` for an id
that failed to resolve would run a demoted user's work with authority they never
held.

## 2026-08-23 — the announcement that never happened

1392 tests, 0 fail. Typecheck clean.

`announceDataWrites` taps every Litestone write and routes what it sees into the
same bus and channel fan-out `callService` uses, which is the whole of how a
write outside a service reaches an open tab. **It has never announced anything
in a real app** (`FJS-464`).

The tap finds the service for a model through one index, built as
`svc.model ?? singularize(name)`. `createService` fills `model` with the SERVICE
NAME when a file declares none — so the `??` never took its right-hand side, the
index was `orders → orders`, and the lookup was `Order`. Every service in every
app is named in the plural (Invariant 2), so it missed for all of them, and
`FJS-010` and `FJS-307` were both dead the day they shipped. Measured on
`example` by printing the index: fourteen services, fourteen plural keys, zero
hits, while a webhook settled an order and no tab moved.

**The tests could not see it because every one of them declares `model: 'Order'`
by hand**, which is the one shape no real service file has. The three added
cover what an autoloaded file actually writes: no `model:` at all, the plural
accessor, the singular. The index is built through `accessorCandidates` now —
the same table `getTable` and `_gateLevels` walk — with a declared `model:`
beating the one derived from the URL.

`createBaseService` was the reason `svc.model` held the wrong thing, and it was
dropping four options besides (`FJS-462`). The loader spreads what a factory
returns into `createService`, so a key that object does not carry was never
declared: `model`, `paginate`, `idField` and `softDelete` all fell through to
defaults. `idField` and `softDelete` are the quiet ones — both reach `_meta`,
which the devtools and manifest plugins read, so they were reported correctly and
enforced as undefined. `db` is still deliberately not carried: it is a function,
and no config key may land on that object as a callable own key.

**A state transition made outside its own service announced nothing either**
(`FJS-463`) — the tap mapped create/update/remove and let `transition` fall
through. A webhook settling an order, or a job advancing a state, moved the row
and told nobody. It announces under the MOVE's name now (`orders pay`), which is
what `callService` announces for the same move through the owning service, so a
subscriber has one event either way. Fixing that exposed the other half: a
transition fires BOTH event kinds for one write, so the first version broadcast
twice. Litestone stamps the update with the move's name — and only when the
transition event is really coming, since it is suppressed for `asSystem()` — so
the consumer skips one without ever skipping both.

Found by building `example`'s payment provider, where the seller's socket saw
nothing after a webhook settled an order.

## 2026-08-23 — which tenant is this call for, asked once

1386 tests, 0 fail. Typecheck clean.

Three subsystems needed the answer and none of them could get it. `withTenantDb`
resolves the tenant for a REQUEST under `strategy database`; under
`strategy row` nothing was assigned anywhere, because the tenant is a value
inside the principal — unreachable for a cache key built from a service and a
query, for a relay sweeping a table, and for a job running an hour later. Each
of the three answered it itself and each answered it wrong.

**`ctx.locals.tenantId` is the answer under both strategies now, assigned in two
places and no third.** `withTenantDb` keeps its assignment; `liftRowTenant`
takes the claim the schema NAMES — `tenancy { claim }`, so a cart token or an
invitation claim sets nothing — off the principal, from `sessionFields` before
the resolver runs and off `applyClaims` after one has. `tenantOf(ctx)` is the
accessor and `app.tenant()` is the same question asked from somewhere holding no
ctx: the call first, then the request, because a service whose subject IS the
tenant may re-resolve mid-request and a request-wide answer would be the wrong
one for exactly the caller who has two.

**The cache was serving one tenant another tenant's rows, under both strategies**
(`FJS-386`). The row filed it against `strategy row` on the ground that the
client is per tenant otherwise — but the cache is on the APP, not the client. A
`:t=` segment now lands OUTSIDE a custom `keyBy`, so a key function written
before tenancy existed cannot silently lose the partition, and
`cache: { shared: true }` is the declared opt-out. The `uid` segment is what hid
it: a cached list IS keyed by the caller, so the leak needed the same person in
two workspaces, which is the shape every B2B app has.

**The outbox relay read a file nothing had written to** (`FJS-365`). It resolves
the same set of databases the request path can write to — one per tenant off the
registry — dispatches with the tenant so the handler writes back to the file the
row came from, and counts `pending` across all of them. An app carrying both an
app-level db and a registry is refused at BOOT rather than in the pass, because
the pass logs and continues and the whole failure is a queue that quietly never
drains.

**`app.runAs(actor, { tenant }, fn)`** is the seam deferred work rides. WHO was
already re-resolved across the boundary and WHERE was not, so a job that had to
touch tenant rows had no legal way to be in a tenant. `membershipClaim` falls
back to the ambient tenant when `tenantFrom` finds no header — and still READS
the membership row for that actor and that tenant, so a caller who lost it
between asking and running is refused rather than replayed. Storing a tenant is
not storing a session: an id names which rows, and the standing is still derived
from the re-resolved principal.

`tests/tenant-scope.test.ts` (11) and four cases in `tests/outbox.test.ts`, all
against a real Litestone client — the failure here is a caller being served
somebody else's rows, which looks exactly like success from anywhere not holding
both.

## 2026-08-23 — a filter means the same thing on both transports

1371 tests, 0 fail. Typecheck clean.

The socket was always the correct half: `buildWsQuery` spreads filters into a
JSON frame, so a boolean stayed a boolean and `{ id: { in: [1,2] } }` stayed an
object. The HTTP leg `String()`d every scalar, `JSON.stringify`d every container
and dropped `null` outright, and nothing on the far side turned any of it back —
so an app worked until its socket dropped and then silently filtered on text
(`FJS-450`, ruled as `FJS-D125`).

`@frontierjs/toolbelt/query` is the encoder and the transport is the decoder, so
the two are inverses by construction. `ctx.query` on a `TransportContext` is now
the PARSED query — `?qty=5&live=true&qty[gte]=3` is structure, not text — with
the `$` keys still present, because splitting those off is the service
boundary's job. A raw route reads the same thing, and the three readers in this
package that assumed a string say so now.

**A WS frame is not parsed and must not be.** It is JSON and already carries its
types; running the parser over it would turn a filter that genuinely says the
string `'5'` into 5.

`tests/query-parity.test.ts` puts one call down both transports and compares —
13 cases, which no unit test on either side can see. Two things it caught:
`$wrap=false` arrives as a boolean now, and reading only the string spelling
made the tri-state collapse; and `$first` was being sent as the string `'true'`,
which the encoder correctly quoted as text.


## 2026-08-23 — the gate leads the chain, and `validated:` is the phase after the derived layer

1358 tests, 0 fail. Typecheck clean.

An app's own before hook used to run ahead of `gateAuth`, so a rule that reads
the database read it for strangers. Measured on `example` — two unauthenticated
POSTs to `/api/orders`, one naming a customer that does not exist and one naming
a real one, answering 400 `That customer is no longer on file` and 401: an
existence oracle over a gated table (`FJS-403`, ruled as `FJS-D124`).

**`gateAuth` is an around hook now.** Leading the per-method before list would
not have been enough — `resolvePipelines` runs `before.all` ahead of
`before.<method>`, so a service or an app declaring `before: { all: [...] }`
would have kept the defect intact. A service-level around hook wraps every before
hook at either scope, and still sits inside the app-level `withLitestoneDb` that
scopes the client the gate reads. One hook rather than six, since the operation
is a property of the method.

`autoValidate`/`autoFilter`/`autoSort` still trail the app's hooks, for the
reason the whole layer used to: a before hook shapes `ctx.data`, and it is the
shaped payload that must satisfy the validator.

**`validated:` is a fifth phase**, between `before` and the method — the slot for
a rule that needs a graded caller and a coerced payload, which had nowhere to
live. It short-circuits like `before`, and it is skipped when a before hook has
already answered the call. `HOOK_STAGES` is now one list, because a stage
`resolvePipelines` walks and `mergeHookMaps` does not is a hook somebody declared
that never runs.

Both `surface.snapshot.md` in this repo carry the move as a diff.


## 2026-08-22 — the console page is not cacheable

Browser drive 25/25.

It is served by the socket's own server, which makes a cached copy the one that
misleads: with the API stopped the page still loaded, the socket could not
connect, and the only symptom was a badge reading `disconnected` — which reads
as a broken console rather than an app that is not running (`FJS-421`).

`Cache-Control: no-store`, and the badge names the retry. The drive asserts the
header and that the socket reaches `live`; it had been asserting the panels
rendered without ever asserting the connection behind them.


## 2026-08-23 — a header the caller varies, over either transport

1348 tests, 0 fail. Typecheck clean.

Over HTTP a per-call value is a header and there was never a question. Over the
socket there are none: the server sees the UPGRADE request's headers, one set
for the life of the connection. The workspace had needed this since it was
written, so it was built as one name — `meta.workspaceId` on the frame, lifted
onto `ctx.client.headers` on the server — with a comment saying "ONE key,
deliberately", because merging a client-supplied header map wholesale would let
a frame carry its own `Authorization`.

That reasoning is right and the conclusion was one name too narrow. The answer
is an allow-list: `config.http.callHeaders` declares which names this app
reads, `client.setCallHeader(name, value)` sets one, and it rides real headers
over HTTP and `meta.headers` over the socket. The declaration has **two
readers** — the CORS middleware and the frame merge — because a header missing
from one is dropped by the other, and an app that had to remember both would
work until the socket came up or until it was served from a second origin. The
identity is still not among them (`FJS-428`).

`setWorkspace` is one of these now rather than its own spelling on each side.
An older client's `meta.workspaceId` is still accepted, so the two cannot
disagree.

Two things fell out of it:

**CORS lost junction's own protocol headers to any app that configured it.**
`X-Service-Method`, `X-Workspace-Id` and `Idempotency-Key` were in the DEFAULT
for `cors()`'s `headers` option, which is the same as always until an app
states a list — and `defaultConfig` states one. So every app configuring CORS
through config kept none of them, and cross-origin the preflight refused the
header and the request never arrived. They are added rather than defaulted now
(`FJS-427`).

**A CRUD method written on a `createBaseService` definition was dropped.**
`collectCustomMethods` collects the non-CRUD names by construction, so an
`async get(ctx)` beside `model:` was never called and the generated row-by-id
answered instead — a plausible wrong shape rather than an error. It overrides
now, wrapped in the same `withDb`, with the derived hooks untouched since they
attach by method name (`FJS-426`).

## 2026-08-22 — the console stopped compiling its own socket frames

1345 tests, 0 fail. Browser drive 23/23.

`(h[m.type]||Function)(m.data)`. `Function` was there as a no-op fallback; as a
value it is the constructor, so an unknown frame compiled its payload as source
— `String({})` is `"[object Object]"`, which parses as an array literal and
throws `missing ] after element list`, with the `[` blamed on line 3 of a
function body nobody wrote (`FJS-420`).

The server sends eight frame types and the map handled six: `call_start`,
`hook` and `query` go to Sierra's toolbar, not to this page. So on any app doing
real work the console filled with parse errors — one per service call, one per
query.

**The drive could not have caught it**, and that is the more useful half: it
drove the console's REST API and never called the app, so the only frame the
page ever saw was the `state` snapshot on connect. It makes real service calls
now and asserts that nothing was compiled as source.

That run turned up a third thing. A leftover console held 8503; `ready()` errors
are caught and logged by the start phase, so the app came up reporting
`devtools=disabled` — which it was not, it was asked for and failed — while the
drive silently graded the *previous* run's queue. The plugin reports
`refused — port 8503 already in use` now, and the drive refuses a port that
already answers instead of testing whatever is on it.


## 2026-08-22 — what a snapshot describes, and what it must not depend on

1345 tests, 0 fail. Typecheck clean. Browser drive 20/20.

Three fixes, all found by wiring the devtools console into two real apps.

**A port-less boot skipped `load-config`.** It is a `needsHost` phase and
`_startForTest()` skips those — which is what the snapshot tools boot through.
So anything a plugin reads out of `junction.config.js` was absent for exactly
the callers whose job is to write down what the app is. `junction jobs` wrote
*"a queue is installed and no handlers are registered"* for an app with three
handlers and a nightly cron (`FJS-418`). The phase body is `app.applyConfigFile()`
now, and `tools/app-module.ts` calls it before `_startForTest()`, in the position
production runs it — the same shape as the `autoloadServices` workaround already
beside it.

**The console bound its server in `register()`**, which `configure()` runs
synchronously — so describing an app opened a listener on 8503, and would have
thrown had anything held the port. It binds in `ready()` now: a `needsHost`
phase, skipped by a boot without a port, which is what a host-bound sidecar
should be (`FJS-419`).

**And a gitignored env var was changing a committed file.** Bun auto-loads
`.env` from the cwd; every snapshot generator is rerun from its own file's
directory; that directory is the app root. `DEVTOOLS=1` in `basecamp/.env` put
the console in its committed plugin list, and CI — which has no `.env` — would
have failed the file for not listing it. `clearLocalToggles()` runs before the
module import rather than inside `build()`, because `defineEnv` evaluates at
module load and a variable cleared afterwards has already been captured. Proven
by generating with the toggle on and off and diffing: identical.


## 2026-08-22 — a config directory that is not there says so

1332 tests, 0 fail. Typecheck clean.

`loadConfig` treated a missing config DIRECTORY exactly like a missing config
file. The second is an optional miss and should stay silent — an app may declare
nothing. The first is a path the app named, and nothing will ever be read from
it (`FJS-415`).

Measured in `basecamp`, which read `api/config` for its whole life without that
directory existing: it booted on framework defaults looking configured, and its
`.catch(() => defaultConfig)` had never once run. What that cost was its CORS —
the app installed it by hand off `config.cors`, a top-level key no config shape
defines, so the read could never produce a value and every boot took the `['*']`
fallback. The API answered any origin.

The env-var overrides moved into one function while doing it, because an early
return that skipped them would have silently dropped `PORT` as well.

The static half of the same problem is `fli check`'s new `surface-config` rule,
and the plugin-facing half is `FJS-416`: a plugin reads `junction.config.js` in
`boot()`, never in `register()`, because `configure()` runs `register()` before
the file is loaded.


## 2026-08-22 — one owner for what an app says about itself

1328 tests, 10 of them new, 0 fail. Typecheck clean.

**The devtools console had a second copy of `/metrics` and it never read the
plugin registry.** `registerMetricsSource` is the seam a plugin contributes
through; `/metrics` merged those sections and the console — which runs on its
own port and had assembled its own object since it was written — did not. Its
renderer has a loop for plugin-injected sections and had never had one to draw,
so Caravan's queue stats and the outbox's pending count were visible at an
endpoint people curl and absent from the surface they open (`FJS-414`).

The fix is that the answer is a function and a route is a caller:

```ts
collectMetrics(app, startedAt)                    // the /metrics body
collectHealth(app, startedAt, opts.checks)        // the /health body
```

Both exported from `transport/health.ts`; `/metrics`, `/health`, `/api/state`
and the console's `/api/health` are the four callers. What holds them together
is a test comparing the two surfaces field by field, rather than one that
restates either.

**Readiness gained the seam metrics already had.**

```ts
app.registerHealthCheck('outbox', () => lastPassAt === null || fresh())
```

`checks` was an option on `healthPlugin()`, so the only thing that could declare
a check was the app author — a plugin owning the resource that fails had no way
to say so, and every app hand-wrote the probe or went without. App-declared
checks are applied **last**, so a name the app states wins: the plugin
registered its probe without knowing what the app knows about the same resource.

The outbox is the first caller here, and it grades against the interval the app
configured rather than a number chosen in the plugin — three missed passes, and
silent until the first one runs, because *not started yet* is not *stuck*.

`collectHealth` takes no `checks` argument, and that is the same repair as the
metrics one: the app's declared probes go onto the APP, so every reader answers
one set. Held in `healthPlugin`'s closure they were invisible to the console —
basecamp's own `db` check was graded at `/health` and silently missing from the
screen someone opens to ask whether the app is healthy.

**The console has a Jobs panel.** It reads `app.jobs` directly rather than
proxying Caravan's own admin routes: those are opt-in (`admin: true`), live
behind the app's `apiPrefix`, and are a second origin from the console's port.
Queue depth, the stall age (`oldestRunningMs`, the number that separates a
stalled queue from a busy one), every handler's declaration with its cron and
next fire, the job list with its payload and error, and retry / cancel / run-now.

Acting on a job is POST-only — a retry reachable by GET is a retry a link
preview can fire — and the run-now picker is filled from `registrations()`, so a
name cannot be typed into a dispatch no worker will ever pick up. The write
verbs are safe to ship because the console already refuses to bind in
production without an `auth` gate.

**The startup banner says where the console is, including when it is off.**

```
🚀 app v1.0.0 url=… health=…/health devtools=http://localhost:8503 mode=production
🚀 app v1.0.0 url=… health=…/health devtools=disabled              mode=production
```

The banner is derived from MOUNTED ROUTES and the console has none — it is a
second server on a second port — so the one place an app says what it is serving
had never mentioned it. `off` and `refused` are separate values: an app that
switched the console off read identically to one whose console had declined to
bind in production without an auth gate, and those want different next actions.

The URL is the port the server actually BOUND rather than the one it was asked
for, because `port: 0` is how a parallel suite avoids a collision and a banner
echoing the request would advertise `:0`.

**The console moved to 8503.** It defaulted to 4000, which is outside the
framework's port scheme entirely — and the scheme exists because a server that
silently takes somebody else's number is a drive testing the wrong app. 8503 is
its slot in the global tooling block (`packages/cli/core/ports.js`), which is
now reserved **whole** — 8500–8509, refused by the formula for every slot rather
than for the three that happened to be assigned, since handing out the next free
one surfaces as a tool that has quietly moved.

Three packages restate the number by hand — junction's plugin, sierra's toolbar,
the CLI's table — because none of them may import the others. What checks it is
that the browser drive opens the console on its **default** port and states none.

## 2026-08-22 — a custom method declares the payload it accepts

1306 tests, 0 fail. Typecheck clean.

**`autoValidate` covered CRUD on a model service and nothing else.** Every other
method a service answers — `pay`, `ship`, `recordTracking`, `prune` — took
`ctx.data` on trust: no shape, no required keys, no types. That is the largest
unguarded surface junction had, because the operations an app is actually
interesting for are exactly the ones that are not CRUD. `example`'s own
`recordTracking` read `$.data as { trackingCode?: string }`, and a cast asserted
three things and checked none of them.

**The declaration goes where the surface is already declared.** A `methods:`
entry may be an object:

```ts
methods: [
  'find', 'get', 'create', 'update', 'patch', 'remove',
  'pay', 'ship', 'refund', 'cancel',
  { method: 'recordTracking', input: 'TrackingUpdate' },
]
```

`TrackingUpdate` is a `type T { … }` in the app's OWN seed. It reaches `$defs`
beside the models, and `validateInput` compiles it through the same
`jsonSchemaToJunctionSchema` → `createSchema` pair `autoValidate` uses — so the
seed stays the one owner of what a shape is (Invariant 4), and the 400 carries
`x-messages` and renders in `<Form>` exactly like a CRUD one. A CRUD name may
carry an input too, replacing the model-derived validator, which is the only way
a create accepts a payload the model does not describe.

**A named type that is not there throws, where a missing model warns.** A model
definition that does not resolve is a config that used to work; an `input:` is a
statement the author made this morning, and failing open on it hands back the
assurance it was written to provide. The message names the type and lists the
object types the schema does have.

**Declaring an input is also declaring the surface** — the one sharp edge.
`{ method: 'pay', … }` narrows exactly as `'pay'` does, so a service with no
`methods:` that gains one to turn validation on answers 405 to every verb it did
not name. That is caught before production rather than in it: `surface.snapshot.md`
carries the policy-applied method list and now the declared inputs too, and the
`snapshots` CI phase fails a stale one.

**What it does not buy is a transform, and that is recorded rather than
half-wired** (`FJS-401`). `@trim`/`@lower`/`@upper`/`@slug` are Data-boundary
rules, emitted into JSON Schema nowhere, and a custom method's payload never
becomes a model write. Wiring them naively would make the two boundaries
disagree about what is VALID, not merely about output: litestone transforms
before validating, junction's `def.transform` runs after, so `@trim @length(3,12)`
on `'  ab  '` fails at one boundary and passes at the other.

**A litestone defect found on the way** — a `type T { … }` field emitted its
structure and none of its presentation, so `@label` and an authored validator
message were carried for a model column and silently dropped for the identical
declaration inside a type. Every realm then wrote the default sentence over the
author's, for a nested `Json @type(T)` value as much as for a declared input.
`applyPresentation` is now one function with two callers.

Also: `DERIVED_HOOKS` matches by NAME and cannot be sound — an app hook called
`autoFilter` reads as derived. Said so at the definition, and `isDerivedHook(fn)`
is the identity-based answer for anything holding the function. One test fixture
was named `validateInput` and started reading as framework-derived the moment a
real hook took that name.


## 2026-08-22 — claims on the principal, and a refusal that stops signing people out

1283 tests, 0 fail. Typecheck clean.

**`createApp({ principal })`** — claims resolved per REQUEST and merged onto the
calling principal before the Data boundary scopes the client from it (`FJS-D113`,
`FJS-374`). One seam, inside `withLitestoneDb` and `withTenantDb`, because those
are already the two places a client is scoped and a third order of operations is
how a standing comes to live on the client alone: `getTable()` re-derives its own
copy from `ctx.auth.user`, so anything the resolver put only on `ctx.locals.db`
is dropped the moment a service touches a model.

Two things it refuses. A resolver may not set `userId` or `id` — claims say what
this caller HOLDS, not who they are, and a framework that stripped the key in
silence would leave an app believing it had switched identity. And it does not
run for an anonymous caller, because minting a principal out of claims alone
turns *nobody* into *someone*: an object that satisfies `auth() != null` while
carrying no identity.

**`membershipClaim()`** ships the shape almost every B2B app has — a person
belongs to several tenants through a membership row, picks one per request, and
holds a standing that lives on that row. The whole of its safety is one line: no
row is no claim. The hand-written version that forgets the membership check emits
the claim anyway and every read answers 200 over somebody else's rows. The
membership row is parked at `ctx.locals.membership`, so the standing costs no
second query.

**`tenantClaimGuard` now answers 403 rather than 401, in three sentences rather
than one** (`FJS-383`). It refuses a signed-in caller holding no tenant claim on
a row-scoped service, which is right; the status was not. 401 means *you have not
proved who you are*, and the caller has — so every client treats it as a dead
token, and a member of A following a link into B was not refused but logged out
of A.

Three refusals wear the same empty principal and they are three different
answers. *Nothing in this app emits this claim* is a developer's problem, and the
only one where no resolver has run. *This request names no tenant* is a **400** —
an incomplete request rather than a refused one. *This caller does not belong to
the tenant it names* is a 403. The first cut collapsed the last two, which
produced a refusal that named nothing: *you do not belong to the workspaceId this
request names*, to a request that named none. Only the resolver can tell them
apart, so it says so, and `membershipClaim({ namedBy })` carries the app's own
actionable sentence — *pass X-Workspace-Id or ?workspace_id=* — into a framework
refusal that could not otherwise know it.

## 2026-08-22 — `$`, the service call you are inside

**`enterCall(ctx, fn)` is exported** (added after the first cut). `callService`
opens the scope for every ordinary path, so the one it does not cover is a
hand-built context calling a method as a plain function — which this suite does
in `populate`, `real-litestone-client` and `accessor-resolution`. Those pass
because `createBaseService`'s CRUD reads the ctx PARAMETER; a method reading
`$` had no way in at all, and nothing outside the package could open one. It
nests and restores, and it sits on `@frontierjs/junction/testing` beside
`testCtx`, which is the thing that produces the context it needs.

1283 tests, 17 new, 0 fail. Workspace typecheck clean. `example`: `verify` 37/37,
`verify:live` 14/14, `verify:jobs` 9/10 (the tenth is a pre-existing mismatch between
`occurrenceKey('outbox', …)` and the drive's bare-uuid assertion, unrelated).

Every service reached its caller-scoped Litestone client by digging it out of the context
and every helper took a `ctx` parameter to carry it — basecamp wrote `dbOf(ctx)`/`wsOf(ctx)`/
`actorOf(ctx)` and used them **251 times**, with a comment on the module saying it existed so
the fact was stated once. The failure that shape produces is not verbosity: reaching for a
module-level client instead writes as the system, with the gate and every row policy gone,
and nothing says so.

**`$` is the context of the call in progress**, read out of a second AsyncLocalStorage store.
`$.db`, `$.data`, `$.id`, `$.locals`, `$.enqueue`, `$.me` — the whole `ServiceContext`, plus
`db` (`ctx.locals.db`) and `me` (`ctx.auth.user`) as derived accessors.

**Two rules make a surface this broad safe, and neither is smallness.**

*Read-only.* Every write trap throws. A writable ambient object is cross-cutting mutable
state with no owner, which is the thing worth refusing; `ctx.locals` is the per-call bag and
`app.claim()` is the app's (Invariant 5).

*Call lifetime.* Outside a call `$` throws by name rather than answering `undefined`. An
ambient dependency is an undeclared one — `steps(id)` does not say in its signature that it
needs a call — and what makes that acceptable is that the failure is loud, immediate, and
names where `$` IS legal. Answering `undefined` would trade a loud bug for a silent one,
which is the trade this exists to reverse.

**Resolved on every property read, never snapshotted.** `transactional:` assigns
`ctx.locals.db = tx` before running the method, so a captured value is the wrong client and
every write in the method would commit outside the transaction.

**The span is the whole of `_callService`** — method policy, idempotency claim, pipeline,
announcement, `afterCommit` drain, outbox handoff. Everything that semantically belongs to
the invocation. A nested call runs it again with its own context. A replayed idempotent call
returns before any of it and runs no user code, so it is owed nothing.

**It is a second store, deliberately, and not `runInServiceCall`.** That one is read by
litestone's write tap to suppress a double announcement, and widening it to this span would
stop a write inside an `afterCommit` effect from being announced at all. `tests/call-scope.test.ts`
asserts the narrow store is already closed by `afterCommit`, so a later merge fails loudly.

**`db` and `me` are not enumerable.** They are accessors, not data, and listing them in
`ownKeys` made a spread EVALUATE them — `{ ...$ }` on an app with no Litestone client threw
the "no client" error from a spread that never asked for a db. Found by the suite.

Perf: one extra ALS `run()` per service call, measured at **42ns** against a 5,634ns no-op
call — 0.75% of the cheapest call that exists, and far less of a real one. The three-branch
block in `callService` that existed to avoid exactly this cost is unaffected; it guards the
request store, which still opens only on a principal change.

**`example/api/services/orders.service.ts` is the first migration** — the one service with
`transactional:` and `ctx.enqueue`, and three drives on it. Both "no scoped db on ctx.locals"
guards are gone with the casts that fed them, `move()` takes no parameter at all, and the
file is two lines shorter while saying more.

## 2026-08-21 — the request scope has one owner (`enterRequest`)

1266 tests, 10 new, 0 fail. Workspace typecheck clean. `example`: `verify` (37) and
`verify:live` (14) green; basecamp's suite 132 green.

Five entry points establish a request — the HTTP handler, the WebSocket frame dispatcher,
`app.runAs()`, a service call that arrives with no store at all, and the test harness — and
each of them built a `RequestMeta` literal by hand. The five copies were not the same, and
both failures that shipped are the same shape as each other: **the socket path wrapped
nothing for its whole life**, so `requestMeta()` was `undefined` for every WS call and the
`Idempotency-Key` that decides whether a create runs twice applied to half the transports;
and **`withTestMeta` forwarded four of six fields**, dropping `user` and `client`, so
propagation behaved one way under test and another in production.

**`enterRequest(src, fn)` is the one owner.** A transport hands over what it holds — an
origin, headers where it has them, a principal, a client — and the meta is built here. The
three header-derived fields have one reader: `x-request-id`, `idempotency-key`,
`accept-language`. A sixth transport cannot forget a field it never names.

**`reenterAs(user, fn)` is the other question, kept separate.** `enterRequest` says *a
request starts here*; this one says *the same request, someone else* — service A running as
alice calling B as bob. Everything but the principal carries over, because a correlation id
that changed mid-request is a broken trace. It also owns the two cases that are not
re-entry: the same principal opens **nothing** (on the common path the two are the same
object by construction, and an ALS `run()` per service call would be paid by every nested
call in the app to change nothing), and no store at all means this call IS the entry point.
`callService`'s three-branch block collapses into one line.

`runWithMeta` is gone from the module's exports — `_requestStore.run` now has exactly one
caller, so the ownership is structural rather than conventional. It was never in the
package's public surface; `requestMeta()` is unchanged.

**`tests/request-scope.test.ts` is the gate**, and it asserts from OUTSIDE: a service method
that records `requestMeta()`, driven down each entry point in turn. Neither shipped failure
is visible from inside the entry point that has it — the app runs, the call answers, and
what is missing is a store nobody in that file reads. Both mutations were re-applied and
each turns exactly one assertion red.

## 2026-08-21 — a claim can be resolved per request (`FJS-D113`, `FJS-374` part one)

1256 tests, 13 new, 0 fail. Workspace typecheck clean.

Row tenancy read its claim off the principal and told you to put the column on the
session, which is **one tenant per sign-in**. A person who belongs to several accounts
and holds a different authority in each could not be expressed, so basecamp declared its
tenancy by hand on fifteen models and wrote ~260 lines around it.

**`createApp({ principal })`** resolves claims per request and puts them on the principal
before the Data boundary scopes the client from it. No new schema syntax: `tenantClaimGuard`
already reads the claim's name off `$tenancy`, and row tenancy already compiles the
predicate and the `@default(auth().<claim>)` stamp — the only thing missing was a second
route onto the principal.

**It lives inside `withLitestoneDb` rather than beside it.** Three things have to happen in
one order — resolve, build a fresh principal and assign `ctx.auth.user`, then scope — and
each is something an app got wrong at least once: writing only the client loses the standing
the moment a service touches a model, because `getTable()` re-derives its own scoped copy;
mutating the session leaks one call's tenant into the next call on a socket, since a WS
session is resolved once at upgrade and handed to every frame. One hook means there is no
order left for an app to arrange.

**A resolver may not set `userId` or `id`** — refused by name. A claim says what a caller
holds for this request, never who they are, and a framework that quietly dropped the key
would leave an app believing it had switched identity.

**It does not run for an anonymous caller**, on the ground `tenantClaimGuard` already
states: minting a principal out of claims alone turns *anonymous* into *someone* — an
object satisfying `auth() != null` while carrying no identity.

**`membershipClaim()` is the battery**, and its whole value is one line: it cannot emit a
claim it did not verify. Under declared row tenancy the hand-written version that forgets
the membership check scopes a stranger INTO the tenant and every read answers 200. It is a
function rather than seed syntax because `@@tenant(via:)` already means *scoped through
this parent*, and because a declaration would hard-code one model, one subject column and
one standing column — false for membership through a team or a role that is a join.

**Two things the tests found rather than confirmed.** A caller with no claim is not an
empty list: `tenantClaimGuard` refuses with a sentence, which is better than the behaviour
these tests were first written to expect, so a non-member gets a refusal naming the claim
rather than a silent empty screen. And that guard's advice predated this seam — it said
*put the column on the session* and nothing else, which is exactly wrong for the shape
this release adds; it now names both routes and which one fits.

`withTenantDb` takes the resolver too. A standing is orthogonal to which database a tenant
lives in, and wiring it to one strategy would make `createApp({ tenants, principal })`
silently do nothing.


## 2026-08-21 — the page had two homes and one of them was inert (`FJS-367`, `FJS-370`)

1243 tests, 6 new, 0 fail. Workspace typecheck clean.

Both found reading basecamp's `core/hooks.ts` and `core/resource.ts` to decide where
they should move, and asking whether anything in them belonged closer to the framework.
Both are things every app pays for and only a dogfooding app notices.

**`paginate()` was inert in every app that used it.** Measured: `GET
/things?$limit=5&$offset=10` through a service carrying the hook answered
`ctx.locals.paginate = {limit:20, offset:0}`. `$` is transport syntax, the bridge moves
every `$` key onto `ctx.directives`, and the hook read `ctx.query.$limit` — never there
past the bridge. This exact class was swept once before and the comment recording it sits
twenty lines from the hook; a grep for `$` reads off `ctx.query` now finds only
`parseQuery`'s documented pre-directives fallback.

**The fix is that it stops publishing a second copy.** Reading directives instead would
have fixed the symptom and left the cause: `ctx.locals.paginate` was a parallel home for
a fact the bridge owns, in a different shape under a different name, and that is what
drifted. The hook NARROWS `ctx.directives` now, which is also what makes a ceiling reach
anything — a custom `find` handing directives to Litestone gets it without threading a
second value. `ctx.locals.paginate` is still written, typed as the same `Page`.

**`clampPage` is the one answer to what a limit means**, in `core/directives.ts`, the
module that imports nothing. `parseQuery` calls it too: the hook used `parseInt` +
`Math.min`, so `$limit=abc` reached it as `Math.min(NaN, 100)` where the same request
through a model service gave the default. A limit of 0 survives — it is how a caller asks
for the count alone. **A model service was never affected**: `paginate: { default, max }`
is a service option threaded into `parseQuery` correctly, which is why the hook could
stay broken.

**`ctx.locals.db` was declared and still unusable.** The defect was filed as *junction
declares nothing* and that was wrong — the litestone adapter has always augmented
`ServiceContextLocals`. What a compile actually says is that `asSystem()` types,
`ctx.auth.user?.userId` types, and **`ctx.locals.db.post.findMany({})` is `unknown`**,
which is every data call. `[model: string]: unknown` sat beside a fully-written
`LitestoneTable` the index signature never used, so an app wrote `dbOf(ctx): any` and
lost the client's safety to reach its own tables.

**Why it could only say `unknown`**: an interface's declared members must satisfy its own
index signature, and `asSystem(): LitestoneClient` is not a table. Split into
`LitestoneClientApi` and intersected with `{ [model: string]: LitestoneTable }`, which
that rule does not reach. `LitestoneTable | unknown` is not the fix and looks like it — a
union with `unknown` collapses to `unknown`, the trap `FJS-034` hit on
`ServiceDefinition`. The cost is that any accessor name resolves, traded knowing a
Litestone client throws on an unknown property and an app wanting compile-time names
generates its own types. `tests/context-db-types.ts` is compiled rather than run.


## 2026-08-20 — the keepalive with no client half (`FJS-366`)

1237 tests, 0 fail. Typecheck clean.

**Every WebSocket in every app was evicted after 30s.** The channels plugin
reaped any connection that had not sent `{type:'ping'}`, and the client method
that sends one was called by nothing — not junction, not sierra, not the
scaffold. A fresh app opened a socket, got `{type:'connected'}`, and was closed
with `connection evicted` ~35s later, reconnecting ~1s after each. It hid
because the reconnect worked and the socket carried no event in between: a live
list just never updated.

**The drive moved to the server.** It pings an idle socket every 15s and evicts
one silent for 40s. The client answers from its message handler and not from a
timer, which is what keeps a backgrounded tab connected — browsers throttle
timers to ~1/min in a hidden tab, slower than any eviction window, while a
message handler is not throttled. An app calls nothing.

Two smaller things were wrong under it. **Only a ping refreshed liveness**, so a
client making service calls over that same socket was evicted while plainly
alive; any frame counts now, malformed ones included, since the parse can refuse
a frame the sender was alive to send. And **the client's default interval was
30s against a 30s timeout**, so calling it would have raced the reaper anyway.

`channels(setup, { heartbeatInterval, heartbeatTimeout })` are the knobs.
`startHeartbeat()` stays, at 15s, for a client whose server predates this.
`tests/heartbeat.test.ts` runs the loop against real sockets at 100ms/400ms.


## 2026-08-19 — a 404 that named `undefined` (`FJS-359`)

`createLitestoneBase` resolves its accessor with `model ?? ctx.service`, and six
`NotFound` messages interpolated the bare option. `model` is undefined whenever a
service relies on its filename — the default the autoloader is built around — so
every miss in a scaffolded app answered `undefined with id=… not found`. One
`modelLabel(ctx)` reading the same fallback the table resolution already uses.


## 2026-08-19 — the body a signature is computed over, and a test request that waited (`FJS-349`, `FJS-350`)

1232 tests, 0 fail. Typecheck clean.

**`ctx.$raw.rawBody`.** A signature binds a hash of the body, so a hook handed
only the parsed object has to re-serialise to check one — which means the sender
and the receiver must agree on key order, spacing and number formatting forever.
`parseBody` already decoded the text for JSON, urlencoded, XML and plain text;
it keeps it now (`parsed.raw`) and the transport carries it. Absent for
multipart and for no body, because there is no single string to hash.

This is what made basecamp able to verify the requests an Outpost sends it
(`FJS-349`) — the endpoints took no credential at all, behind a comment saying
the transport had handled it.

**`request(app)` no longer fires before it is awaited.** The builder ended with
`Promise.resolve().then(execute)`, which schedules the call the moment the
builder is made: any `await` between `.post(path)` and `.send(body)` let the
request go out first, with no body and without any header set after that point.
Nothing said so — it succeeded, the service saw `null`, and the test asserted
against that. Found writing the signature tests, where computing a signature is
itself an await. Lazy now, memoised on first `then()`.


## 2026-08-18 — a service can reserve a query key, and the reservation is lifted

A search key had exactly two readings and a service needed a third. `$`-names
are directives and `@frontierjs/toolbelt/directives` owns every name under them
(Invariant 10); everything else is graded against the model's columns by
`autoFilter`. So basecamp's documented `?workspace_id=` fallback was answered

    400 Unknown filter key 'workspace_id' — did you mean 'workspaceId'?

before the hook that reads it ever ran — and the app could not fix it from its
own side, because both readings belong to the framework.

`reservedQuery: ['workspace_id']` on the service is the third answer. It is the
**query-side mirror of `@transient`**: declared where it is owned, then lifted —
the keys move to `ctx.reserved` and `ctx.query` is columns alone.

**The lift is in `callService`, before the pipeline**, not in a hook. A hook
would be too late for half the readers: an app's own leading hook needs the
clean query as much as the derived `autoFilter` behind it, and a custom method
runs neither. One place, both transports, every method.

**Two refusals, each put where it is decidable.** A `$`-name is refused at
construction — that one needs no client, since the directive table owns those
spellings and a reservation would put two owners on one name. A name that is
also a COLUMN is refused on first use instead, because the client is not known
when a service module is imported, so there is nothing to ask at construction;
the check runs once per service and then never again. It refuses rather than
resolving: a reservation shadowing a column stops that column filtering with
nothing saying so, which is the silent 200 `autoFilter` exists to turn into a
400.

Asked of a REAL Litestone client. `$checkWhere` is what knows the columns, and a
plain-object db has no opinion at all — against a fake the collision check
no-ops and ships.

`ctx.reserved` is fresh per call and does not propagate, on the same terms as
`locals` and `transients`; `tests/context-contract.test.ts` runs all six fields
rather than describing them. `describe()` reports the reservation for the same
reason it reports `allowBulk` — a caller cannot tell a reserved key from a
column by looking at the URL (`FJS-337`).

## 2026-08-18 — `junction jobs`: what this app runs when nobody asked (`FJS-346`, `FJS-344`)

1219 tests, 6 of them new, 0 fail. Typecheck clean.

Every other snapshot here records a surface someone reaches. This one records
the opposite, and it exists because that is the part of an app whose failure is
silent by construction: a route that stops working is a 404 somebody sees, and a
schedule that stops being registered is *nothing happening*, which looks exactly
like nothing needing to happen (`FJS-327`, `FJS-328`).

Read off a BUILT app, like `junction surface`, for the same reason — a job file
registers itself by being autoloaded and a plugin registers timers of its own,
so what is registered is not what is written down.

**Two registries, kept apart on the page** (`FJS-D36`). `app.jobs` is durable —
a row, a retry budget, a principal re-resolved when it runs. `app.scheduler` is
a bare in-process timer with none of that, running in every replica rather than
once across them. A reader deciding whether a deploy is safe needs to know which
list a name is on. **No queue installed** renders differently from **a queue
with no handlers**: one app does no background work, the other will dispatch
into a queue with nothing to run it.

`app.scheduler` could not be described at all before this. `every()` parsed its
interval to milliseconds and `cron()` compiled its expression to a matcher, so
the only record of when a timer fires was a closure and `list()` answered
`job_1`, `job_2`. The expression is retained now and `describe()` reads it.

Live state is deliberately absent — no next run, no queue depth, nothing paused.
Those move between two boots of identical code, and a committed artefact that
cannot hold still is worth nothing.

**`tools/app-module.ts`** is new and not a refactor for its own sake: loading an
app, refusing an ambiguous module, running the non-host startup phases and the
`--check` byte compare are now needed by two tools, and two copies of *how do
you load an app* is how one tool snapshots an app the other never sees.

**A defect fell out of the extraction** (`FJS-344`): `quietly()` reassigned
`process.stdout.write`, which does not reach `console.log` in Bun — console
holds its own binding — so Caravan's autoload line landed as the **first line of
the file** when a snapshot was written by redirecting stdout, above the heading.
It affected `junction surface --stdout` and had done since it was written.

The `snapshots` CI phase picked the new kind up with **no CI edit**: 17 → 19
snapshots, discovered and rerun from the command in each file's own header.

The durable table carries a **Timeout** column and names the handlers that have
none, because an unbounded handler is the one that can stall a whole queue
(`FJS-295`). It earned itself the next day: it printed `**none**` for a job that
had just declared 30s, which is how two silent whitelists in Caravan were found.

## 2026-08-18 — both occurrence keys come from one owner (`FJS-342`)

1213 tests, 0 fail. Typecheck clean.

Two latent collisions, both fixed by `@frontierjs/toolbelt/history`:

**The idempotency cache key** joined four parts on `:` and two of them are
outside this package's control — the header a caller writes, and a principal id
that is whatever the auth provider issues. A principal of `user-1:a` with key
`b` and a principal of `user-1` with key `a:b` produced one cache entry, and a
shared entry is one caller being replayed another's answer. Unchanged for any
principal and key without a `:` in them.

**The outbox relay** dispatched under the bare row id, into a jobs table shared
with every id a caller states on a dispatch of their own — so outbox row 7 and a
caller's `7` were one primary key and whichever arrived second was silently
treated as already done. It is `outbox:<id>` now, which IS a format change: rows
written under the old key would redispatch under the new one, and that is
once-only running twice. It costs nothing while no queue has rows in it.

## 2026-08-18 — the error boundary carries a declared payload (`FJS-341`)

1213 tests, 4 of them new, 0 fail. Typecheck clean.

`adopt()` copied `errors` and `retryable` off an originating error and dropped
everything else, so `VersionConflictError` reached a browser as a bare retryable
409: something moved, and no way to say what. The two revisions are the half
neither the status nor `retryable` can express, and they are exactly what a
screen offering *reload* against *overwrite* needs.

An error class that sets `data` is now declaring a payload for the client — the
same meaning `FrameworkError.data` already has, which is why it is not a second
field name. **Plain objects and arrays only**: an Error carrying a class
instance on `data` is holding a handle to something (a client, a socket, a row),
not a payload anyone agreed to publish, and serializing it is how an internal
object reaches a browser because a field happened to be named `data`.

`junction errors` grew a **Payload** column, for the same reason it records
`retryable`: nothing above `toFrameworkError` reads anything but the result, so
a payload that stops crossing is invisible. The version conflict's row is
asserted whole.

The end-to-end case is in `real-litestone-client.test.ts` — a real client, a
real service, a real thrown conflict — because the question is whether the
payload survives the boundary, not whether a constructed error has the fields.

## 2026-08-18 — an app-level default publisher (`FJS-334`)

Junction had two ways to broadcast and both were per service: `channel:` on the
definition, and a `publish()` hook in `after`. Feathers has a third —
`app.publish(fn)`, one catch-all deciding where every service event goes — and
it is how a tenant-shaped app writes *everything a caller may hear goes to their
own account channel* once instead of once per service.

The shape everyone reaches for was not merely undocumented, it was **refused**:
`app.hooks({ after: { all: [publish(fn)] } })` trips `refuseDoubleBroadcast` for
every service that also declares `channel:` — which is every model service in
`example` and `basecamp` — so an app-level publish hook was a boot failure. The
refusal is right, both really do send, but it left the catch-all with no
spelling at all, and the resulting shape is a rule holding for twenty services
written twenty times, where the missed one is a screen that silently never
updates.

`app.channels.publishDefault(fn)` is that spelling, and the whole of the design
is that it is a **default, not a second broadcaster**: it is consulted only
where a service declares nothing, so it composes with `channel:` rather than
racing it and cannot put one record on the wire twice. The three states a
service already had are what make that work — `channel: 'posts'` says where and
is not asked the default, `channel: false` is the declared opt-out and refuses
it, absent asks the app.

**Function only, no string form.** A string would name one channel for every
service in the app, which is precisely the shape that hands a subscriber rows no
`@@allow` would have let them read — the reason broadcasting is opt-in at all
(`DECISIONS.md` § API design, 2026-08-02). A function is handed the record and
the `ctx`, so the app decides per record, and returning `null` skips that one.

**The report is the other half, because this inverts a failure mode.** Before
it, forgetting `channel:` meant a screen that never updates — visible, and
yours. After it, the same omission puts records on the wire under a rule written
for other services, which nothing on the server can see. So the channels plugin
reports at `boot()` which services fall through to the default, and only when a
default is registered: with none, that list is the ruled, intended state and
would fire on nearly every service in every app, which is how a warning gets
trained out. It extinguishes itself — `channel: false` drops a service from the
list, so an app that has read it once and meant it never sees it again.

`describe()` gained `channel` with it, a summary a JSON reader can hold: the
name for the string form, `true` for a function, `false` for the opt-out, `null`
for a service that declares nothing. `null` is not `false` — one asks the
default, the other refuses it.

Eleven tests in `tests/publish-default.test.ts`, against the **real** channel
manager rather than a stub with a recording `publish`: the whole question is
which channel a frame resolves onto, and a stub that ignores the resolver
answers it by construction. Three mutants, all killed — dropping the fallback,
firing the report unconditionally, and a no-op unsubscribe. Verified: junction
1209 + 11 pass, typecheck clean, `example`'s `verify:live` 14/14.

## 2026-08-17 — `@version` reaches the Data boundary (`FJS-335`)

Litestone's JSON Schema property set is **mode-dependent**, not just its
`required[]`: `@version` is emitted for `update` and omitted for `create`.
Junction derived one document — `generateJsonSchema(c.$schema)`, no options, so
`mode: 'create'` — and compiled both validators from it. The patch validator
therefore had no `version` property, `parse()` dropped the caller's value as an
unknown key, and litestone refused the write for not carrying one.

Every patch of every `@version` model was a 400 saying the version was missing,
from a request that had sent it. The feature did not work through a service at
all.

Nothing was red because junction's own `@version` tests call `svc.patch(ctx)`
directly, where no hook runs. That also made the bulk guard — *a bulk patch
cannot carry a version, it is per row* — unreachable in a real app, since
`autoValidate` had already removed the key it tests for.

`_deriveJsonSchema` now caches per mode, and the patch validator is compiled
from the create property set **plus the version column** — not from the update
document whole. That distinction is the trap in fixing it: the update document
also carries `@id`, litestone writes what it is given, and
`update({ where: { id: 1 }, data: { id: 99 } })` moves the row and answers 99.
Taking the whole thing would have let any caller rewrite a primary key through
a PATCH.

Four tests in `tests/real-litestone-client.test.ts` run through `autoValidate`
before the service, including that one; three fail against the version of this
fix they each guard.

## 2026-08-17 — `cors()` allows the headers the client itself sends (`FJS-336`)

The default allow-list was `Content-Type, Authorization, X-API-Key`. The browser
client sends `X-Service-Method` to address a custom method over HTTP,
`X-Workspace-Id` on every call once `setWorkspace()` has been used, and
`callService` reads `Idempotency-Key`. None was allowed, so a cross-origin
preflight refused the request and it never arrived.

This is invisible in both apps here: a service call takes the socket when one is
connected, and CORS does not apply to a WebSocket. The HTTP path is the
fallback, and the fallback was dead — measured from basecamp's own page, where
`fetch` with `X-Workspace-Id` from `:8020` to `:8120` answers
`TypeError: Failed to fetch`.

All three are junction's own protocol headers, so they belong in the default
rather than in every app's config.

## 2026-08-17 — `normalizeOrderBy` is exported

`autoSort` VALIDATES a request's `$orderBy` — it asks `db.$checkOrderBy` and
answers a 400 naming the key — and then leaves the value RAW on
`ctx.directives`. A service that wants to honour it therefore has to parse the
three spellings (`'name'`, `'-createdAt'`, `{ name: 'asc' }`) itself, and doing
that in a service is how the grammar acquires a second definition.

`normalizeOrderBy`, `comparatorFor` and `compareValues` are now on the package's
public surface. `core/sort.ts` is already named in the Bridge index as *the one
reading of `orderBy`*; this is that sentence being true from outside the
package too.

## 2026-08-17 — services autoload in the test lifecycle too (`FJS-348`)

`autoload-services` was `needsHost: true`. `_startForTest` skips those — they
bind a port, read a config file, install signal handlers — and this one does
none of that: it reads a directory and builds objects.

The cost was invisible until an app was mounted by `@frontierjs/testing` for the
first time. Every call answered `NotFound: Service 'projects' not found` — a 404
that reads like a wrong service name rather than an app with no services in it,
which sends you looking at the wrong thing entirely.

The flag is dropped. A missing directory is already a silent no-op, so an app
that autoloads nothing is unaffected. What a test still cannot reach is
`_junction.services.dir`: `load-config` IS `needsHost`, so `junction.config.js`
is not read there — an app that wants its services mounted in a test states
`autoload:` on `createApp` directly, which is also the only form that survives
`Bun.main` pointing at the test runner instead of the entry point.

1193 tests green.

## 2026-08-17 — services autoload in the test lifecycle (`FJS-332`)

`autoload-services` was `needsHost: true`. The test lifecycle skips those, so an
app mounted by `@frontierjs/testing` started with **no services at all** and
every call answered `NotFound: Service 'x' not found` — a 404 that reads like a
wrong name rather than an app that never loaded anything.

The flag is dropped. Registering services reads a directory and builds objects;
it binds nothing, and a missing directory is already a silent no-op, so running
it without a host costs nothing.

`load-config` is still `needsHost`, which is the one thing a test cannot reach:
`junction.config.js` is not read, so `_junction.services.dir` is unavailable and
an app that wants its services in a test states `autoload:` directly. The
default resolves `./services` beside `Bun.main`, and under `bun test` that is
the test runner — so an explicit path is the right answer there regardless.

Found by making basecamp the first consumer of `@frontierjs/testing`. It is
plausibly why that package had no consumers: the first thing anyone does with it
is call a service.

## 2026-08-17 — the pretty log line: key=value, and no ANSI into a pipe

1193 tests, 0 fail. Typecheck clean. Presentation only — the JSON writer, the
file writer and the `LogEntry` shape are untouched, so nothing a collector reads
changed.

**A boot line's `data` was `JSON.stringify`'d onto the end as one dim blob**, so
the line carrying the most information was the least readable thing on screen:
five keys of braces and quotes at the moment an app comes up. It renders as
`key=value` now, key dim and value bright, a string quoted only when it holds a
space or an `=`. This is the first half of `FJS-D37` §2 — a runtime log is a
stream and gets a stream's format.

**Undefined values are dropped, because `JSON.stringify` dropped them.** The app
banner passes two (`prefix`, `docs`), which the blob had been hiding and the new
renderer showed on every boot; `null` is kept, since stringify kept it and a
stated null is an answer where an absent key is not. Found by reading the suite's
own output after the change.

**The pretty writer emitted escape codes unconditionally**, so `bun run api > log`
recorded them as log content. It now honours `NO_COLOR`/`FORCE_COLOR`/TTY, the
same rule `packages/cli/core/color.js` already applied. `env.ts` was the only
other raw-ANSI writer in `src/` and imports the gate rather than restating the
predicate — env validation runs before an app, and therefore before its logger,
exists, so its two lines stay direct writes to stderr.

## 2026-08-17 — `ctx.transients`, the fifth context field (`FJS-D23`)

1186 tests + 6 new, 0 fail. Typecheck clean.

`autoValidate` now validates the `@transient` keys a model declares with that
model's own rules and then LIFTS them off `ctx.data` onto `ctx.transients`. The
value has to leave the payload: litestone refuses a transient key by name, so a
service passing `ctx.data` on whole would fail the write rather than the field.

`transients` is a context field rather than a corner of `locals`, and the line
between them is who writes it — `locals` is scratch a hook keeps its own state
in, `transients` is call INPUT the framework parsed, the way `directives` is the
input the bridge splits off a query. Fresh `{}` per call, does not propagate, no
seed option, `{}` on a model that declares none. `tests/context-contract.test.ts`
asserts both halves by running them.

**A bulk write carrying one is refused by name.** The rows a service receives are
the ones that PASSED validation — `partitionBulk` parks the rest — so an
index-aligned array of per-row values would pair one row's credential with
another row.

The compiler found the third context factory: `app.ts`'s internal-call `makeCtx`,
which a required field surfaced and a search for `locals: {}` had missed.

## 2026-08-17 — a durable effect: `ctx.enqueue` and the outbox relay (`FJS-D35`)

1186 tests, 0 fail. Typecheck clean.

`ctx.afterCommit(fn)` runs an effect only if the call succeeded and the
transaction committed. It buys nothing against a **crash**: the process dies
between the commit and the callback and the effect is never done, with nothing
anywhere recording that it was owed.

`ctx.enqueue(job, payload)` writes a row inside the call's own transaction
instead, so the intent commits with the write or rolls back with it, and a relay
hands it to `app.jobs` afterwards.

**Two verbs, not one verb with a flag.** A closure cannot be written to a table.
Everything durable has to be addressed by name, so the API says so rather than
letting the first crash say it.

```ts
ctx.afterCommit(() => app.conduit.send(…))   // a function  — dies with the process
await ctx.enqueue('order.shipped', { id })   // name + payload — survives it
```

**The row is in the app's own database and can be nowhere else, which is
measured.** Litestone opens one connection per declared `database` block and has
exactly one transaction manager, over main's write connection: a probe writing
to two databases inside `$transaction` and then throwing rolled main back and
left the other row standing. `$attach` does not help either — SQLite's atomic
multi-file commit needs rollback-journal mode on every attached file, and both
Caravan's queue and litestone's tenants run WAL.

So `db/outbox.lite` ships here, `@@gate("8")`, and is IMPORTED rather than
pasted — the split `@frontierjs/auth` already makes, because machinery that
changes when this package changes has to reach an installed app. `fli
outbox:install` writes the import line; `outboxSchemaFragment(db)` is the
in-memory alternative for an app assembling one schema string.

**Refusals by name, never degradation.** Outside a transaction, on a schema with
no `OutboxMessage`, and with no relay installed — a row nothing delivers is
worse than a refusal. The transaction test asks `db.$inTransaction` (new in
litestone, on every client flavour) rather than reading the `transactional:`
declaration: a hook can run against a method the declaration does not name.

**Delivery is at-least-once and no version of it is not.** The queue is a
separate SQLite file, so the insert there and the delivery mark here cannot be
one transaction. The relay dispatches under the OUTBOX ROW's id and caravan's
`dispatch({ id })` treats a taken primary key as work already queued, so a crash
in between replays into a no-op instead of a second email.

`app.configure(outbox())` installs the relay — `requires: ['caravan']`, and boot
refuses a schema with no model by name rather than waiting for the first
`enqueue`.

**`transport/outbox.ts` is now `transport/send-queue.ts`**, with `flushOutbox` →
`flushSendQueue`, `dropOutbox` → `dropSendQueue` and `OutboxSocket` →
`SendQueueSocket`. Two unrelated things called an outbox in one package is a
trap, and the WebSocket one was the casual name — it is a send buffer that holds
a frame Bun dropped, where the transactional outbox is a pattern with a
literature. `wsSend` is unchanged: it is what anyone debugging a lost frame
greps for. Older entries below name the new path. A committed call kicks it without awaiting; the timer is the recovery
sweep for what a crash left behind, not the latency of an ordinary effect.

`GET /metrics` answers `outbox: { pending, delivered, failed, lastPassAt }`,
contributed through `app.registerMetricsSource` rather than mounted as a second
endpoint. *How many effects are owed* is the first question asked when something
did not arrive, and there was no way to ask it without opening the database. The
counters cover both drivers because `app.outbox.deliver()` is the one place
either goes through; `pending` is a COUNT and therefore a query, refreshed once
per relay pass rather than once per scrape — a metrics endpoint that queries per
request is a load amplifier pointed at your own database. A source must be
synchronous, since `/metrics` assigns `fn()` straight into the body.

*11 tests here against a real Litestone client; the delivery half is 16 more in
caravan, where a real queue exists to hand rows to. Eight mutants, all killed —
two only after they exposed missing tests (the claim's compare-and-set, and the
cross-process primary-key collision).*

## 2026-08-17 — the typecheck baseline is gone, and eleven type defects with it (`FJS-034`)

1176 tests, 0 fail — unchanged. `scripts/typecheck-baselines.json` no longer
names junction: 138 → 0, and absent means 0.

The row said the rest was test ergonomics and reached no user. Half of it was.
The other half was the tests being the only code in this repo that uses junction
the way an app does — so an error in `tests/` was an error a user gets, written
down in the one place nobody was reading it as one.

**A custom method's `ctx` was an implicit `any`.** `ServiceDefinition`'s
`[method: string]: unknown` contextually types nothing, so the documented shape

```ts
createService({ name: 'servers', async reboot(ctx) { … } })
```

is a hard error in any app with `noImplicitAny` on and a silently untyped `ctx`
in every app without it. The index signature is now `ServiceDefinitionValue` — a
union carrying exactly ONE function type, which contextually types the
function-valued keys and still accepts every option value. `| unknown` collapses
straight back to `unknown`, which is why the obvious widening does not work.

**`ctx.result` is `unknown`.** It was declared as the envelope alone, which is
narrower than every assignment the framework itself makes — including two of its
own, both of which carried a cast to get past it. A short-circuiting `before`
hook may set a plain value, a cache hit replays whatever was stored, and
`toResponse` handles a bare `Response`. Read the payload with `resultData()` and
the whole answer with `unwrapResult()`, which is what the email-hook docs already
did by hand.

**`createBaseService` returns a `BaseServiceDefinition`.** Its return type was
built from `Service`, whose `hooks` is the registration METHOD rather than the
map — so `createService({ ...createBaseService({ model }) })`, the spread this
file documents, did not compile.

**`app.events.on('x', () => seen.push(n))` compiles.** `EventHandler` was
`=> Promise<void> | void`, and TypeScript's return-a-value-where-void-is-expected
rule applies to a bare `void` and not to a union containing one — while `emit`
already tests the return for `.then` and ignores anything else. The type now says
that: `=> unknown`.

**`config: { http: { helmet: false } }` was a type error twice over and a silent
data loss once.** `AppOptions.config` was a one-level `Partial<AppConfig>` while
`deepMerge` merges all the way down (`DeepPartial` now), `AppConfig['http']`
never declared `helmet` although `app.ts` read it through a cast, and
`createTestApp` spread its config SHALLOWLY — so naming one key of `http` dropped
`cors`, `ddos`, `powered` and `maxBodySize`. It deep-merges now, like `createApp`.

Four more of the same shape:

- `bridge.toContext`'s `model` was required and read nowhere. It defaults to
  `service`, which is what `internal()` has always passed.
- `OriginList` refused a single origin string that `cors()`'s own `isAllowed` has
  always had a `typeof origins === 'string'` branch for. `combineOrigins` wraps a
  bare string into the one-element list csrf needs, which takes neither a
  wildcard nor a bare string.
- `OAPathItem` names its five verbs, so `paths['/posts'].post` is an operation
  rather than `OAOperation | OAParameter[]`.
- `partitionBulk<T>` demanded the parse callback return `T`, while both callers
  return a coerced record. `<TIn, TOut = TIn>`.

**Two things that never ran at all.** `test:example` and `test:all` passed
`example/test.ts` as a FILTER, and bun matches a filter by `.test`/`.spec` in the
filename — the path form runs the 26 tests that had been silently skipped. And
`makeWsApp` in `index.test.ts` called an unimported `channels`, so it could only
ever have thrown; nothing called it.

Test-side: `tests/helpers.ts` owns the two casts this suite kept rewriting —
`stubbable` for a fetch stub (Bun's `typeof fetch` carries `preconnect`, so no
plain function is assignable to it) and `asRecord` for a key the type does not
declare, which is Invariant 5 working rather than a gap. 18 duplicate imports
removed from `index.test.ts`, and a `let` assigned inside a callback replaced by
a collector wherever flow analysis had narrowed it to `null`.

Three of the eleven were in litestone and are in its own `CHANGES.md`.


## 2026-08-16 — `ctx.afterCommit()`, the phase an `after` hook is not (`FJS-089`)

1176 tests (10 new), 0 fail. Baseline unchanged at 138.

`after` means after the METHOD. Hooks run in sequence, so an `after` hook that
sends an email runs, a later one throws, and the client is told the call failed
with the email already gone — and once `transactional:` landed, the row was
rolled back while the email stayed sent, which is worse. Rails states the choice
as `after_save` vs `after_commit`; only the first existed here.

`ctx.afterCommit(fn)` is the second. Queued from any phase, drained once in
`callService` on `!ctx.error && !pipelineError` — after the announcement, before
`idem.settle`, so a replay cannot be told the call is finished while its effects
are still running.

**Under `transactional:` it is after the commit for free, which is what makes it
small.** The transaction is an `around` hook, so `runPipeline` has already
returned by the time the drain runs: no transaction state is read, nothing is
kept in step, and one drain point serves both the transactional and the ordinary
case. The queue lives on the CONTEXT rather than on `ctx.locals.db`, which that
hook reassigns mid-pipeline — a callback queued before the swap and one queued
after it both run.

**Observer tier** (`FJS-D06`). A throw is logged and emitted as
`junction.aftercommit.error`, never reported as the call failing: the write is
committed and the broadcast is out, so a 500 would tell the client a write
failed that did not. The callbacks after it still run.

`withAfterCommit()` is the one owner — the two builders in `bridge.ts`, the
internal one in `app.ts`, and `callService` for a context built by hand. The
argument type is the context minus the two fields it adds, so a builder's
literal is still checked against everything else it owes.

**What this is not is durability.** A crash between the commit and the callback
loses the effect and nothing is recorded. That is the transactional outbox, and
it is open as `FJS-D35` with the question that blocks it: the row has to be in
the app's own database on the connection the pipeline already writes through,
and Caravan's queue is a different SQLite file — so `dispatch()` from a hook
buys retries, not atomicity.

Ten tests against a real Litestone client, both guards mutation-checked: drop
the drain and eight fail, drop the success guard and the two failure-path tests
fail.

## 2026-08-16 — a worker receives its setup data (`FJS-271`)

1166 tests (7 new), 0 fail. Baseline unchanged at 138.

`createThread(path, data)` exported a second parameter that went nowhere, and
the file's own header said *"Worker scripts receive data"*. **The filed
diagnosis was wrong in the useful direction**: `workerData` is not part of the
web `WorkerOptions`, so it looked undelivered — but on Bun 1.3.11 it IS
delivered, and only to `node:worker_threads`. Inside the worker
`globalThis.workerData`, `self.workerData` and `Bun.workerData` are all
`undefined`, which is exactly what the original measurement probed. So the fix
is a read half, not the protocol decision the row was waiting on: no envelope,
no `init` handler, no reserved message name.

`workerData()` is that half, and it answers **`undefined`** where Node answers
`null` — on the main thread and in a worker given none alike, because a caller
cannot act on the difference between *nobody passed anything* and *somebody
passed nothing*, and `?? fallback` should read the same in both places.

**Setup and work stay apart**, which is what makes this cheap: setup is read
once at module scope, work arrives per message on the loop the pool already
drives. A worker written against `workerHandler` cannot confuse the two because
they never share a channel.

Three things came with it:

- **`createPool(path, count, data)`** — a pool had no way to configure its
  workers at all.
- **One `spawn()`**, the only place a `Worker` is constructed. A pool respawns
  after an error, and a respawned worker built without the setup data serves a
  different configuration than its siblings from the first failure onward.
- **A pool now REJECTS on a handler that threw.** `workerHandler` posts
  `{ __error: true, message }` back — a worker cannot reject its caller's
  promise from inside itself — and `exec()` resolved with that envelope: the
  caller's `await` succeeded, the failure arrived as a property nobody reads,
  and `stats.completed` counted it as work done. Found while writing the tests.

`tests/workers.test.ts` runs real threads, because the whole question is what a
second thread receives and a stand-in answers whatever it was written to answer
— which is how a documented, exported parameter shipped going nowhere.

## 2026-08-16 — the schema's types reach the browser (`FJS-018`)

1159 tests (5 new), 0 fail. Baseline unchanged at 138; `src/` stays at zero.

Litestone has generated `Post`/`PostCreate`/`PostWhere` for as long as it has
had a typegen, and the browser client has been generic since it was written.
Nothing joined them, so every browser call was `Record<string, unknown>` and an
app that wanted better hand-wrote the shape — which is what the `Seeder` type in
`example/fullstack/app.ts` was, and it is deleted.

**One registry, augmented rather than passed.** `ServiceTypes` is an empty
exported interface here; `litestone types --augment junction` emits the module
augmentation that fills it, keyed by SERVICE name, and `service('posts')` and
`resource('posts')` infer from it with no type argument at any call site. That is
the same mechanism `app.claim` uses for a slot an app fills (Invariant 5), and it
is the one that survives a call site nobody edits: a type parameter has to be
restated everywhere, which is the thing being removed.

**Nothing changes for an app that generates nothing.** With the registry empty
`keyof ServiceTypes` is `never`, so the inferring overload matches no call and
every one falls through to the open overload. `service<Post>('posts')` also still
resolves — an explicit argument fails the first overload's constraint and falls
through rather than erroring, which is asserted rather than assumed.

**The mapping in `ServiceRow` is load-bearing and cost an hour.** A proxy is
generic over `T extends Record<string, unknown>`, and a TypeScript INTERFACE —
which is what a generated row is — does not satisfy that: only a type alias of an
object type gets the implicit index signature. Passed straight through, the
constraint failed and the fallback took over, so the whole feature compiled,
inferred nothing, and looked finished. Mapping the members
(`{ [P in keyof ServiceTypes[K]]: … }`) satisfies the constraint and still
refuses an undeclared column.

**`ResourceResult.service` was untyped** — a bare `ServiceProxy`, so
destructuring `{ service }` off a resource dropped the row type the caller had
just asked for. Now `ServiceProxy<T>`.

`tests/client-types.test.ts` is the proof and it COMPILES: the real generator's
output, junction's real client behind the package specifier the augmentation
names, `tsc --noEmit` over the fixture. The negative half rides the same run —
`@ts-expect-error` is itself an error when the line it marks type-checks, so the
day inference silently widens back, the fixture fails.

## 2026-08-16 — `changed`: a write that cannot name its row still announces (`FJS-307`)

1160 tests (10 new), 0 fail. Baseline unchanged; `src/` stays at zero.

The tap installed for `FJS-010` dropped every event whose `result` was null,
which is one line and two whole classes of write: a bulk statement that answers
`{count}` and never built the rows, and a `select: false` write that skipped its
RETURNING. So a job doing `createMany` left every open tab stale — the same
defect `FJS-010` closed, one method over.

Litestone now says which it is (`scope`), and a rowless event is broadcast as
**`changed`**, carrying `{ model, operation, count }`. One name for all three
operations, because the only honest answer on the other side is the same for
each: ask the query again. Which operation it was travels in the payload for a
bus subscriber that wants it.

**`where` reaches the bus and never the wire.** The bus is in-process and can
hold the caller's filter; a channel goes to every subscribed browser, and a
filter is made of the caller's own values — `deleteMany({ where: { resetToken } })`
would otherwise put one on a socket. The two payloads differ by that field and
the test asserts both halves.

The browser store answers `changed` with the reload it already gives an
undecidable record, coalesced per burst, and the `*` catch-all skips the name —
without that, `{ model, operation, count }` would be upserted into the store as
if it were a row. Not `stale`: that counter is for a gap the list knows the
shape of, and *some unknown rows moved* is not one.

Not proved end to end. `example` has no bulk write reachable from a request, so
the frame is asserted here and the store's answer in the client suite; the link
between them is the frame dispatch every other event already uses.

## 2026-08-16 — a write nothing announced now announces (`FJS-010`)

1144 tests (9 new), 0 fail. Baseline 138, unchanged; `src/` stays at zero.

`callService` is the single announcement point, so a mutation that never went
through a service told nobody — a `db.asSystem()` write in a job, a raw route
writing through the client, a Litestone plugin. Every open tab kept the stale
row with a 200. `announceDataWrites(app, db)` installs a `$tapEvents` tap at
`createApp({ db })` and routes what it sees into the same bus + channel fan-out
callService uses, so there is still one shape of announcement.

**Suppression is keyed on the service NAME, and that is the substance.** Every
service write passes the tap too, so without a check each mutation would go out
twice. The first version asked *am I inside a service call* and swallowed the
audit row an `orders` after-hook writes — a different service, genuinely
unannounced, and `orders created` says nothing about it. Measured, then
narrowed: the ALS holds the announcing service and the tap compares. A nested
call re-runs it with its own name, so the innermost scope is the one that will
announce.

The ALS is read inside a `setImmediate` callback and works because the scope
propagates through scheduling. If that ever stops holding, every service write
announces twice — `tests/data-write-announcement.test.ts` is what says so.

**Two limits, both reported rather than guessed.** A **function** `channel:`
resolver takes `(rows, ctx)` and an orphan write has no ServiceContext to hand
it, so that service gets the bus and one named warning per process; inventing a
ctx would pass the app's own resolver a principal nobody authenticated. And a
model no service is built over is silent by design — an app may have tables its
API does not expose.

The `$tapEvents` probe is wrapped in a `try`: a Litestone client throws on an
unknown property, so feature-detection is itself a throwing expression, and an
older client has to leave `createApp` standing rather than take it down. That
was a real failure, caught by the stub client in `accessor-resolution.test.ts`.

Not installed for `createApp({ tenants })` — there the client is per request
rather than per app, so there is no single client to tap.

## 2026-08-16 — `rateLimit` is typed for both contexts, because it always ran on both (`FJS-063`)

It returns a **`BridgeHook`** — `(ctx: ServiceContext | TransportContext) => void`
— rather than `Hook`. The parameter is wider, so it stays assignable to `Hook`
and a `before:` map is unchanged.

Nothing about the behaviour moves. This hook is a service before-hook AND the
limiter `@frontierjs/auth` puts on its own `/auth/*` routes, which are plain
handlers; both things it reads go through accessors written for either shape,
and the comment above it has named auth as the reason since `FJS-017`. The
signature was the only part that had not caught up, and nothing said so because
auth typed those handlers `any` — which is what closing `FJS-063` removed.

## 2026-08-16 — the template directives, and what `$search` was answering (`FJS-306`, `FJS-292`)

**`$withTemplates` / `$onlyTemplates` reach the Data boundary.** `QueryDirectives`
declares them, `parseQuery` reads them off `ctx.directives` and off the `$`-in-
query fallback alike, the service forwards them to `findMany`/`findUnique`/
`findFirst`, and the browser client emits them on both wires. Same pair as
`withDeleted`/`onlyDeleted`, one Data-realm feature over — an app declaring
`@@hasTemplates` could not ask for a template from anywhere above Litestone.

**`$search` on a model that HAS `@@fts` was answering nothing.** `table.search()`
returns the rows, ranked; the find branch destructured `{ rows, total }` off that
array, so a search that matched came back `{"limit":20,"offset":0}` — no data, no
total, status 200. The same shape as the `restoreMany` that never existed
(`FJS-245`): a method typed on `LitestoneTable` that nothing executed. The type
now says `Promise<unknown[]>`, the rows are the rows, and the envelope's total is
a second id-only pass, skipped when the first page is short enough to BE the
total. The four visibility flags reach `search()` too.

Below `@@fts`, Litestone now refuses by name with a 400 rather than a bare Error
that arrived as a 500 (`FJS-292`); `errors.snapshot.md` records the new class,
and picks up the lock and soft-delete-unique rows that had gone stale in it.


## 2026-08-16 — the browser client speaks `directives`, and can finally say all eight (`FJS-290`)

1129 tests. Typecheck **138, baseline lowered from 139**.

`FindParams` was two things wearing one name. It held `query` — the filters —
alongside `limit`/`offset`/`orderBy`/`select`/`populate`, so the container was
both halves of a split the rest of the framework keeps apart (Invariant 10). And
it named five of the eight directives, so `$search`, `$withDeleted` and
`$onlyDeleted` had a server that read them (`parseDirectives`), a URL grammar
that carried them, a type in `core/context.ts` that named them — and no way for
`client.service(x).find(…)` to ask. Sierra inherited the hole: a `.lite`
declaring `@@softDelete` gave an app a restore flow it could not build a list
screen for, and FTS5 search was reachable only by hand-writing a URL.

Both are one fix. The second argument is now a **`QueryDirectives`** — the same
declaration the bridge reads — and filters are the first argument, always.

`QueryDirectives` moved to **`src/core/directives.ts`**, a module that imports
nothing. It had to: the browser client needs the type and `core/context.ts`
imports `node:async_hooks`, which does not exist in a browser and would ride
into every bundle on a type-only import a build step failed to erase.
`context.ts` re-exports it, so every existing import keeps resolving.

`directiveParams(d)` is the one table both wire builders read, replacing two
hand-written field-by-field walks. That duplication is how `$populate` came to
be emitted over HTTP and not over the socket once — a difference nothing can see
from the call site, since the client prefers the socket whenever one is up. The
parity test now asserts against `DIRECTIVE_PARAMS` rather than a hand-written
list, in both directions: every name emitted is a name the bridge strips, and
every directive declared is a directive emitted.

`$first` and `$wrap` stay out of the type and are passed by the one call site
that needs them — they are transport-only and have no structured form on the
other side, which is exactly the line `@frontierjs/toolbelt/directives` already
draws between `DIRECTIVE_PARAMS` and `TRANSPORT_PARAMS`.

One escape hatch is new and has one caller: `get(id, directives, _wire)`. The
WebSocket→HTTP fallback holds a frame whose directives are already in `$`
spelling, and parsing them back so this method could re-emit them would be a
second translation of the convention on the client — where the point of the
shared table is one per boundary.

Also fixed: the module header's own example was `find({ query: { status: 'online' } })`,
a Feathers idiom that filters on a column named `query`. With `FJS-289` landed
the same afternoon, that now answers a 400 naming the key instead of an empty list.

## 2026-08-16 — a provider is what Junction calls (`FJS-D10`)

1129/1129 tests pass (+5, `tests/session-verifier.test.ts`). Typecheck baseline
unchanged.

`IAuth` declares six required methods. This package invokes two of them:
`verifySession`, on the HTTP path and the WS upgrade, and `sessionFor`, behind
`runAs`. `login`, `logout`, `createUser` and `deleteUser` are called by
`@frontierjs/auth`'s own `/auth/*` routes and by nothing here — so an app
authenticating against something it already had was stubbing four methods that
would never run, and a stub that throws cannot be told apart from a provider
that works until the day something calls it.

`createApp({ auth })` and `setAuth()` now take **`SessionVerifier`**, and the
whole of it is `{ verifySession }` with `sessionFor` optional. The absence of
`sessionFor` stays LOUD — `runAs` throws by name rather than downgrading a
caller to STRANGER(0).

**It is derived, not declared beside `IAuth`** — `Pick<IAuth, 'verifySession'> &
Partial<IAuth>` — and both halves earn their place. A hand-written member list
drifts the moment `IAuth` grows a method. And `Partial` is what keeps a FULLER
provider assignable: TypeScript's excess-property check rejects an object
literal carrying a key the target does not name, so a narrow interface listing
only `verifySession` refused `{ verifySession, login, … }`, which is exactly the
provider it exists to accept. That was measured, not predicted — the first shape
broke four call sites in this repo's own examples and tests.

`tests/auth-cookie.test.ts` is the receipt: three of its stub providers were
written `: IAuth { … } as IAuth`, casting past five methods they do not
implement. The casts are gone.

**`createSchema` takes an optional type parameter.** `createSchema<CreateOrder>({
… })` makes `parse()` answer `CreateOrder` instead of `Record<string, unknown>`,
with the field map constrained to that type's keys so a missing or invented one
is a compile error. The type is STATED rather than inferred, and that is the
ruling: a model service is validated by `autoValidate` off the generated JSON
Schema and writes no schema at all, so this is the hatch for a shape the seed
does not describe — and for that shape the author already holds the type.
Inferring it instead means building zod inside a framework whose thesis is that
types come from the seed. Untyped calls are unchanged.


## 2026-08-16 — `resolveAccessor`: the derived hooks were asking a question the client could not answer (`FJS-289`)

1129 tests, 4 of them new here. Typecheck clean.

`autoFilter` and `autoSort` passed `accessorOpt ?? ctx.service` straight to
`$checkWhere` / `$checkOrderBy`. A service that declares no `model:` is named
for its URL, which is plural, and both check functions answer `[]` for an
accessor they do not know — the same value they answer for *no problems*. So the
hooks read *I cannot judge this* as *this is fine* and validated nothing.

Measured on `example`, whose four services all omit `model:`:
`GET /api/orders?bogusColumn=7` answered **200 with an empty list**, plus a
Litestone warning on stderr that no client can see. That is the exact
silent-empty-screen `FJS-109` created the hook to end — working for nobody who
used the default.

**The sort half was masked.** Litestone throws on a bad `orderBy` at execution
where a bad `where` only warns, so `?$orderBy=-bogus` answered 400 from the
backstop while the hook above it did nothing. One of the two looked correct and
neither was.

`resolveAccessor(client, accessor)` is the fix and the one owner. It resolves
off `$schema` rather than probing, because no probe can separate the two
meanings of `[]`. `getTable` and `_gateLevels` had walked `accessorCandidates`
since the naming slip that silently disabled authentication; the hooks that ASK
rather than LOOK UP never got it.

Every existing test declared `model:` explicitly, which is why the coverage was
green throughout. The new describe omits it — the shape the autoloader produces.
Verified by reverting: the filter test goes red, the sort test does not, which
reproduces the masking.

## 2026-08-16 — `app.provide` is `app.claim`, and metrics get a real seam (`FJS-D06`)

1120/1120 tests pass. Typecheck baseline unchanged.

`app.provide(name, value)` never provided anything. It takes a name on the app
object and throws if something already holds it — Fastify's `decorate`, and the
error message it has always thrown says *already claimed*. Now the verb agrees:
**`app.claim(name, value)`**. The rename exists because `FJS-D06` gave `Provider`
a meaning — a third party the app speaks to, an identity provider or a payment
provider — and a verb that means *claim a namespace* standing next to a noun
that means *Stripe* is two concepts one keystroke apart.

**`_metricsProviders` was the same word in a third sense** — a thing that
supplies a number — and it was also a private field two packages reached into
behind an `instanceof Map` guard. Conduit's own `docs/AUDIT.md` had written down
what that costs: rename the field and metrics disappear with **no error
anywhere**, because a guard that fails just skips. So the field became
`_metricsSources` and the reach-in became a declared seam,
**`app.registerMetricsSource(name, fn)`**.

That is the half worth keeping. Conduit now calls it unguarded — it imports
Junction's own `App` type, so a missing seam is a compile error — while Caravan
keeps a presence check, because Caravan legitimately runs against hosts that are
not Junction apps at all. The integration tests on both sides drive a REAL app,
which is what makes a skew between the packages loud instead of silent.

Breaking for anything calling `app.provide()` or writing `app._metricsProviders`
directly: caravan, conduit, notifications, webhooks and basecamp, all updated.


## 2026-08-16 — per-request tenants (`FJS-D05`)

`createApp({ tenants })` takes a Litestone tenant registry and installs
`withTenantDb` **in place of** `withLitestoneDb`: one `ctx.locals.db`, and two
hooks assigning it would leave which wins to hook order. Each call resolves its
tenant, and the resolution is **asked rather than re-derived** —
`registry.tenantFor({ host, headers, principal })` applies the `resolve` the
schema declares (a subdomain, a header, a claim), so this side contributes only
what a transport has and what a refusal's status code is. A second reading of
`resolve subdomain` living up here is how two answers to one question drift.

Work with no request behind it — a job, a scheduled sweep, a webhook replay —
names its tenant with `{ locals: { tenantId } }`, which is what `locals` being
hand-down-able is for. No tenant resolvable is a 400 naming how the schema says
to name one; an unknown tenant is a 404.

Row tenancy needs no hook and fails the other way round: the schema's own
policies scope every query, so a **signed-in** principal carrying no claim
matches no row and every screen is an empty list with a 200 — indistinguishable
from a tenant with no data, and almost always a missing `sessionFields` entry.
`tenantClaimGuard` refuses that by name on a scoped service. Anonymous is
deliberately not its business: nobody is not a caller missing a claim.

## 2026-08-16 — `app.principal()` / `app.runAs()`, the seam deferred work runs through

1120 tests, unchanged — the behaviour is proved from Caravan, which is its only
caller. Typecheck clean.

`auth` propagating (below) fixed calls *inside* a request. Work that outlives
one — a job, a retry, a scheduled sweep — still had no principal, because the
store is gone by the time it runs. Two members answer it, and neither is
Caravan-specific: `app.principal()` reads who is in scope from somewhere holding
no `ctx`, and `app.runAs(userId, fn)` opens a scope for a principal **resolved
now**, so `fn` makes ordinary service calls that name nobody.

`createApp({ system })` is the third piece: the principal an app is when it acts
on its own behalf, for work nobody asked for. Declaring none gives `null` rather
than an invented identity — inventing one would hand every app a privileged
principal it never requested.

`IAuth.sessionFor(userId)` is new and optional: build a session for a caller
presenting no credential. **It proves nothing**, so it must never be wired to
anything a request can name. A provider lacking it makes `runAs(userId, …)`
throw by name rather than quietly downgrade to STRANGER(0), which is the bug
this exists to remove.

`createTestApp({ system })` forwards it — a test that cannot declare a system
principal cannot tell that answer apart from *no principal*.



## 2026-08-15 — `auth` propagates, and `ctx.params` is gone (`FJS-D03`)

**The contract said `auth` propagated and it did not.** Measured: a nested
`ctx.app.service('inner').find()` from inside a service saw `null`, while
`core/context.ts` documented the field as *"Frozen. PROPAGATES across internal
calls (carry caller identity so authz stays consistent)."* An internal context
was built from `opts.auth` alone — there was no ambient anything — so every
boundary that starts a call chain began at STRANGER(0) unless a human threaded it
by hand. That is the same root cause as the Caravan job hazard, and why
`example` carries an `app-ref.ts` singleton and `{ auth: { user: SYSTEM as never } }`
in every job.

It propagates now, and it needed no new machinery: the principal joins
`RequestMeta` in the `AsyncLocalStorage` store the transport **already** wraps a
whole request in, so nothing is threaded and no caller object is rebuilt. Three
rules, all executed in `tests/context-contract.test.ts`:

- a call naming no principal inherits the one in scope, **at any depth**
- an explicit `{ user: null }` stays anonymous — **absent is not null**, tested
  with `in` rather than `??`, which is what preserves *read this as a stranger
  would*
- a call whose principal DIFFERS re-scopes, so a sub-call made as somebody else
  passes **that** principal to its own children rather than the request's

`client` propagates by the same route, for the same reason: an audit hook three
calls deep has no other way to reach the IP of the request that caused the write.
It is information, never authority.

A test that pinned the old behaviour — *"app.service() without params makes an
anonymous call"* — is rewritten. Its own comment called that an "anonymous system
call", which is the opposite thing: STRANGER(0), not level 8.

**`ctx.params` is gone from both contexts.** Path captures are `ctx.route`
everywhere in Junction — `TransportContext`, `WsContext` and `ServiceContext` —
and Sierra keeps `page.params`. Deleted rather than aliased: in Feathers `params`
is the whole context bag, that idiom keeps arriving here (`ctx.params.user`,
`ctx.params.headers`, `app.service(x).get(id, ctx.params)`), and a field of that
name holding *something else* is how a role check reads `undefined` and passes
for everyone. Absent, the idiom throws.

The guidance that told people to thread `ctx.params` — in this package's own
`app.ts` comments — is rewritten, since there is now nothing to thread.

`CLAUDE.md` gains **§ The two contexts**: which one you are holding and when,
where they must agree, where they deliberately differ, and the four fields with
their four different rules.

## 2026-08-16 — `client.auth`, and the token gets one owner (FJS-D20)

The browser client could sign in and could not do anything else: no register, no
`me`, no password reset, and `logout()` cleared the token locally without telling
the server — so a sign-out left the session row valid until it expired. Nothing
in this repo had ever called `POST /auth/logout`.

`client.auth` is the whole surface now — `signIn` / `signUp` / `signOut` / `me` /
`changePassword` / `sessions` / `revokeSession` / `revokeOtherSessions` /
`apiKeys` / `createApiKey` / `revokeApiKey` / `requestPasswordReset` /
`confirmPasswordReset` / `requestEmailVerification` / `verifyEmail`. It lives
here rather than in `@frontierjs/auth` because this is the object that holds the
token, opens the socket and knows both prefixes; an app writing its own sign-in
had to reproduce all three. `authenticate()` is gone — it is `auth.signIn`.

**`tokenStorage` gives the token one owner.** Sierra used to write localStorage
in its own `login()` while the client held its copy in memory, so signing in
through the client left storage empty and writing storage by hand left the socket
unauthenticated. `setToken` now persists, clears, and emits `token` so a cache
keyed on identity (Sierra's prefetch) can drop what belonged to whoever left.

**A 401 keeps the server's own sentence.** `_request` threw `Unauthorized`
without reading the body, so "Invalid credentials" never reached anyone — which
is most of what a hand-written sign-in page was doing when it re-mapped the
status itself.

`IAuth` gains five optional methods (`changePassword`, `listSessions`,
`revokeSession`, `revokeSessions`, `listApiKeys`) and `SessionContext` gains
`sessionId`; `AuthSessionInfo` and `ApiKeyInfo` are what the caller may be shown
about their own credentials — deliberately not the rows, which hold the bearer
token and the key hash.

## 2026-08-15 — a stream is not a result (`FJS-D13`)

Ruled: a stream sits **outside** the envelope and `ResultKind` stays
`single | list`. The envelope answers what a call RETURNED — one record or a page
of them, with `total`/`limit`/`offset` and the bulk protocol's `errors` — and a
stream returns nothing and then repeatedly, so every field of it is meaningless
for one.

**A third `kind` would have been silent.** It is branched on at ten sites, listed
in `core/envelope.ts`'s own header, and a new value lands in each as *not a
list* — treated as a single, `data: undefined`. That is the class of drift the
module exists to end.

**The framework already streams and already answered this the other way.**
`publish()` is an after-hook, so a pushed frame IS `ctx.result` — through
`protect()` and the whole pipeline — and `unwrapResult` strips the envelope at
the wire. Unwrap at the edge, not grow a kind.

`wrapResult` now **refuses** a `Response`, a `ReadableStream`, anything with
`getReader`, and an async iterable, by name. It used to wrap them, and both a
Response and a ReadableStream have no enumerable own properties: a service
method returning one answered `{"kind":"single","data":{}}` — an empty object
with a 200, the stream destroyed, nothing said. The refusal names where streaming
does live, because a wall that does not is worse than the bug. 5 tests.

The corollary is the half with teeth: **each frame is a result and the stream is
not.** `ctx.sse()` is a raw-route transport primitive with no `gateAuth`, no
`autoValidate`, no `protect()` and no app hooks — right for a heartbeat, wrong
for records.

## 2026-08-15 — a custom service method is a METHOD (FJS-D02)

`action` was a second noun for a set the CRUD list already defines by
exclusion, and every surface a developer touches had said *method* all along:
the declaration is `methods: ['find', 'get', 'reboot']`, the wire is
`X-Service-Method` over HTTP and a `service_call` frame naming `method` over the
socket, the pipeline carries `ctx.method`, and a refusal is `MethodNotAllowed`.
Ruled: they are methods; *custom* is the adjective where the distinction
matters.

**The wire did not change and neither did the announcement** — a custom method
still announces under its own name (`orders pay`). What changed is the
vocabulary and one public name:

- `svc.action(name, id, data, query)` → **`svc.invoke(...)`** on the browser
  client. Not `call`, which is the WS-only escape hatch already.
- `collectActions` → `collectCustomMethods`, `_actions` → `_customMethods`,
  `actionNames` → `customMethodNames` (the table-first answer), and the old
  scan-only `customMethodNames` → `scanCustomMethods`.
- `describe()` reports `customMethods`; `/metrics` `services.details.*` reports
  `customMethods`; `surface.snapshot.md` prints **custom methods**. Regenerate
  the snapshot after upgrading — the `snapshots` CI phase fails a stale one.

`ARCHITECT.md` §2 carries the vocabulary rule; `DECISIONS.md` § Naming &
vocabulary carries the ruling.

## 2026-08-15 — a live list keeps its order and knows where its page ends (FJS-270)

`Store.upsert` appended. So a list loaded `orderBy: '-createdAt'` received new
rows at the BOTTOM and one loaded `limit: 20` grew past 20 — the row was
genuinely in the query, it was in the wrong place in it, which is `FJS-011` one
field along.

`Store.place(record, idField, cmp, max)` inserts at the sorted position and moves
a row whose sort key a patch changed, in one notification. The comparator comes
from **`core/sort.ts`, which is also `parseSort`** — one reading of `-createdAt`,
or the browser orders a list differently from the query that filled it. Its value
ordering follows SQLite rather than JavaScript: NULLs first ascending and
therefore last descending, numbers before text, a Boolean as the 0/1 it is
stored as, ISO-8601 DateTime compared as text. Where it cannot be exact it says
so in the header — a non-BINARY collation, and UTF-16 code units against bytes
past ASCII.

**Paging is unanswerable from a browser and is not guessed at.** On the first
page the row pushed off the end genuinely belongs to page 2, so trimming is
right. Past page 1 a new row is refused: nothing here knows whether it belongs on
an earlier page, and putting it in would push out a row that does. A removal
leaving a gap only the server can fill is the same case. Both are counted, and
the count is `stale` on the resource — `{ get, subscribe }`, the same shape as a
Store, so anything that bridges one to a UI signal bridges this — cleared by
`load()`, for a view to render as *3 new — refresh*.

The limit and offset are read off the **envelope**, not the params: the effective
limit is the server's, and a caller naming none still got one. A service
answering no pagination metadata leaves it unknown, which turns trimming off
rather than inventing a page size. An unordered list that outgrows its page
counts rather than dropping a row at random — throwing away the row the user just
created, to honour a page size, is the worse half of that trade.


## 2026-08-15 — the consumer surface type-checks, and seven defects were under it (FJS-268, FJS-272)

An app that imports junction compiles junction: the `exports` map points at
`.ts` and nothing emits `.d.ts`, so tsc follows those imports and checks the
framework as part of the app's own program. Measured on a freshly scaffolded
app, that was **61 diagnostics from inside `node_modules` and none of its own**
— and all 61 were junction's. The other five TypeScript packages were already
clean, so this was never the framework-wide problem it was filed as.

`index.ts` + `src/**` is now **0**, from 67. The baseline fell **198 → 139**, and
what is left is `tests/` and `example/`, which no consumer compiles.

Seven things were hiding in there. In severity order:

**STARTTLS was broken against every submission server.** `src/mail/smtp.ts`
called `socket.startTls(...)`. Probed on Bun 1.3.11 that property is `undefined`
— the API is `upgradeTLS`, it takes the socket handlers again, and it returns a
PAIR whose second element is the encrypted socket. So Gmail, SendGrid, Postmark,
Office 365, anything on port 587, died with `socket.startTls is not a function`.
Nothing caught it because the only mail server the drives talk to is the dev
sink, and a sink advertises no capabilities, so the branch never ran.
`tests/smtp-starttls.test.ts` pins it and **runs out of process**:
`tests/email.test.ts` mocks the smtp shim with `mock.module`, which is
process-wide and never undone, so an in-process version passed alone and graded
a mock inside the suite.

**`timestamps()` skipped every row of a bulk create.** `ctx.data` is a row OR an
array of rows; un-narrowed, the hook set `created_at`/`updated_at` as properties
of the ARRAY. `allow()` had the identical shape and filtered nothing on a bulk
payload. Both map over the array now.

**An error's stack never reset the terminal colour.** `line += '\n' + COLOR +
stack ?? fallback + RESET` parses as `(concatenation) ?? (…)`, and a
concatenation is never nullish — so the fallback was dead and `RESET` sat on the
wrong side of the operator. An error with no `.stack` logged the word
`undefined`, and every line after ANY error stayed the error colour.

**`plugins/email/campaign/sender.ts` imported `App` one `../` short.** A
type-only import, so it never failed at runtime and every type in that file was
dead. Fixing the path revealed the file reaching `app.conduit.resolve` with no
guard — a `Cannot read properties of undefined` the first time campaign email is
configured without conduit. It states the slice of Conduit it needs, structurally
and locally, because `AppConduit` is empty here on purpose.

**The OpenAPI generator could not express a header parameter**, so the
`X-Service-Method` line — the whole custom-action calling convention — was an
excess property the spec silently dropped. Path-level `parameters` were
untypeable for the same reason.

**`RateLimitHookOptions` was exported twice from `index.ts`** (a duplicate
identifier), and `RouteSegment` was imported from `router.ts`, which does not
export it.

**`tsconfig.json` was a stale copy of `tsconfig.base.json`** with `DOM.Iterable`
missing from `lib` — so `headers.entries()` was a type error against working
code, which is the exact case the base's own comment warns about. It extends the
base now.

**The casts, and what they were hiding.** Twenty-five `as Record<string,
unknown>` assertions came out. Nine were reaching fields the types already
declared (`app.telemetry`, `app._plugins`, `app.channels`, `ctx.requestId`,
`Channel.name`). Twelve were an **undeclared middleware → transport side
channel** — a middleware runs before the response exists, so it leaves headers on
the context and `_finalizeWithHeaders` applies them at the end. That is one
contract with six fields (`__cors`, `__securityHeaders`, `__rateLimit`,
`__correlationHeaders`, `__pendingCookies`, `__status`) and it was written down
nowhere, so a middleware that misspelled a bucket compiled, ran, and dropped its
headers in silence. They are on `TransportContext` now. `Connection.__joinMeta`,
`Channel.__presenceWrapped` and the `service`/`method`/`params` fields of a
`service_call` frame got the same treatment. What remains as a cast is what is
genuinely dynamic — an action name written onto a service, a method name onto the
router — and each is a two-step with a sentence saying why.

Also: `HookType` never admitted `'method'`, which `runPipeline` sets while the
method itself runs, so a hook reading `ctx.type` could see a value the union
denied. `Bun.serve<WsData>` is stated, so the four websocket handlers agree with
the `_ws*` methods about what is on `ws.data`.

`FJS-271` is filed rather than fixed: `createThread(path, data)` passes
`workerData`, which Bun does not deliver under any name — a public API's second
parameter goes nowhere, and closing it is a protocol decision, not a type one.

## 2026-08-15 — `resource()`'s store is scoped to the query that filled it (FJS-011)

A push is an announcement about a ROW; the store is the answer to a QUERY. The
wiring applied every event to it, so a row outside the filter was added and a row
a patch had just moved out of the filter stayed in, updated in place.

`resource(name, idField, { match })` takes the decision from its caller —
`true` upserts, `false` removes, `null` means *cannot be decided from this
record* and the store reloads instead of guessing, once per burst rather than
once per event. Sierra passes a matcher built from the model's own field rules;
this package holds no schema, which is why it is passed in and not decided here.
A caller passing nothing gets exactly the old behaviour.

The query is recorded when the rows are, inside the `FJS-082` stamp check, so a
superseded load leaves neither its rows nor its filter behind. A custom action
event goes through the same door as a patch: a row can leave a list through one.

## 2026-08-15 — `deriveModelName` uses the shared inflection rules (FJS-192)

It carried its own copy — `ies`/`ses`, no irregular table — so a `people`
service resolved to the model `people`, which does not exist, and the lookup
failed open the way `accessorCandidates` exists to prevent. It now calls
`singularize` from `@frontierjs/toolbelt/inflect`; the `Service` suffix and the
camelCase are still junction's business.

The guards this copy had and the others did not — `us`, `is`, `as`, `ss`, which
stop `status` becoming `statu` — went INTO the shared module rather than being
lost to it.

## 2026-08-14 — two things on stdout that were not news

An app booting printed one `[Loader] Registered service:` line per service and
one `[Junction] anonymous hook on x.before.y` line per PHASE per METHOD. On a
21-service app that is dozens of lines before anything has been served, and the
real warnings — a duplicate service, a file with no factory, a hook map on a
method the service does not have — competed with them for the same scrollback.

They are not the same kind of thing, so they are separated now.
`core/diagnostics.ts` is the one owner of *should Junction print developer
diagnostics*, reading `DEBUG=1` — which junction's own config already maps to
`config.debug`, so this adds a reader rather than a convention.

- The loader's registration line is a diagnostic. `GET /manifest` answers the
  same question on demand.
- The anonymous-hook note is a style note, not a warning: the hook works, it
  just reads as `anonymous` in the telemetry waterfall. It now says everything
  it has to say about one service in ONE line, naming every position —
  `8 anonymous hook(s) on alerts (before.all, before.create, …)`.

**Nothing that indicates a probable defect changed.** A duplicate service, a
load failure, a missing factory, a bad hook target and every `console.warn` in
`litestone.ts` are as loud as they were. The old gate was
`NODE_ENV !== 'production'`, which is true for every developer all of the time
and is therefore not a gate.

## 2026-08-14 — `junction errors` — what a thrown value becomes, executed

`errors.snapshot.md` at this package root: every error class with its status,
one row per branch `toFrameworkError` can take, the status → class table, and
**Litestone's real error classes constructed and run through the boundary**.
`--check` byte-compares; the `snapshots` CI phase reruns it from the header the
file carries.

Every row is a value actually thrown through `toFrameworkError()`, not a table
written from the source. That matters because everything above the boundary
reads only the result: a class that gains a `status` silently stops being a 500,
and one that never had a status is silently a 500 while its message says
otherwise. Neither breaks a test, because nothing asserts on a category nobody
named.

**It found `FJS-255` on its first run.** The three lock errors —
`LockNotAcquiredError` (`retryable: true`), `LockExpiredError`,
`LockReleasedByOtherError` — each declare the one field a status cannot express
and none declares a status, so all three reach a caller as a 500 with
`retryable` intact beside it. Same shape as the transition errors before
`FJS-190`, and the same fix: if you own the class, give it a status.

Constructing them is load-bearing: `status` and `retryable` are set in the
constructor, so a row synthesised from a class NAME reports every one as a 500
with no retryable. That is exactly what the first draft did for the two classes
whose constructors take arguments a probe has to guess.


## 2026-08-14 — `junction surface` — the API surface as a committed file

The Data realm's snapshots (`litestone access`, `litestone ddl`) have an API-realm
sibling. `junction surface --app <module>` writes `surface.snapshot.md`: every
service with its policy-applied methods, its actions, what it broadcasts on, and
its hook chain **in the order it runs**; the app-level hooks that wrap every call;
every path the router mounted, prefix applied; and the plugins in configure order.
`--check` byte-compares the committed file, which is what `scripts/ci.mjs` reruns.

**Read off a BUILT app, never scanned**, because none of it is answerable from
source text: `collectActions` decides at construction whether a key is an option
or an action, `svc.pipelines()` resolves the chain a service actually runs
(`gateAuth`, `autoValidate` and friends lead it, and appear in no service file),
and `apiPrefix` moves routes registered by plugins that never mention it. The
tool asks the declared owners — `svc.describe()` and `buildRoutes()` — and
`serializeHookMap` is now exported rather than copied, so "a hook is its function
name" has one spelling.

The app module must expose the app **without listening**: a built `App`, or a
factory returning one — the same contract `@frontierjs/testing` takes as `api:`.
`--services <dir>` names the autoload directory, because that phase is `needsHost`
(it resolves against `Bun.main`) and an app whose services are all autoloaded
otherwise describes as empty.

This is what `FJS-254` closed against: `fli project:view` re-derived service
metadata with regexes over source, including its own copy of the action rule. It
reads this file now.


## 2026-08-14 — a filtered bulk PATCH/REMOVE writes row by row

`FJS-044`, ruled by `FJS-D11`. The row was filed as an ergonomics gap — bulk
create reports per-row failures, patch and remove answer `{ count }`. Probing it
found an enforcement gap underneath, which is the real reason this changed.

**Litestone does not run `@@transitions` on `updateMany`.** That is deliberate
on its side — a power tool whose caller "takes responsibility", with a note
saying to loop `update()` where transition safety matters. Junction's bulk patch
called `updateMany` directly, so the responsibility was never taken. Verified
through a real service over a real client:

```
PATCH /orders/1            {status:'shipped'}  → TransitionViolationError
PATCH /orders?status=draft {status:'shipped'}  → {"count":2}, both rows written
```

Same forbidden move. `@version` was the same shape — bumped by a bulk write,
never required — so optimistic concurrency was off for the writes touching the
most rows. Both are properties of `update()`, so both come back by calling it,
and calling it per row is also what produces a per-row outcome.

A filtered patch/remove now selects its targets and writes them individually,
answering the `{ data, errors }` list envelope bulk create already did. Gate and
row policy were enforced on the bulk path before and are unchanged; `removeMany`
cascaded correctly and that is unchanged too.

**`bulkMax`, default 1000.** One statement per row means an unbounded filter is
an unbounded number of statements under the single write lock. Over it the call
is refused naming the count, before anything is written. This is the one place
the change can break a working app.

**Only rows the caller can read are touched** — selecting the targets applies
the read policy, the write applies the update/delete one.

**A caller-supplied `@version` on a bulk patch is refused by name.** One value
cannot be right for N rows. Each row is written against the version selected
with it, so a row that moved underneath is a `VersionConflictError` in `errors`
rather than a silent overwrite.

Still no atomicity, on the same terms as bulk create — `transactional:` is how a
caller trades partial success back for all-or-nothing.

The browser client's bulk overloads promised `T[]` (patch) and `string[]` of ids
(remove) against a server that answered `{ count }`; both now say
`ListResult<T>`, which is what actually arrives.

## 2026-08-14 — every filtered restore was a 500

`FJS-245`. `PUT /{service}?filter` reached `restoreImpl`'s bulk branch, which
called `table.restoreMany({ where })` — a function a Litestone table does not
have. `LitestoneTable` declared it, so nothing typed the mistake. `restore({
where })` already takes a multi-row where and answers the rows, so the fix is
one call and it lands restore in the same envelope as the other two. No app in
the repo sets `allowBulk`, which is why no drive ever reached it.


## 2026-08-14 — `transactional:` — a declared commit scope

`FJS-089`'s write half. An `after` hook that sends an email runs, a later `after`
hook throws, and the client sees a rejected create whose row is committed and
whose email has gone. Junction had no phase meaning *the call succeeded*.

```ts
createService({ name: 'orders', model: 'Order', transactional: true })
createService({ name: 'orders', model: 'Order', transactional: ['create', 'pay'] })
```

**`around` is the only phase that wraps the after hooks**, which is what makes
this a commit scope rather than a longer before hook: the transaction covers
before → method → after, so a later `after` hook throwing rolls the write back.

Two orderings carry it and both already held. `withLitestoneDb` is an APP-level
around hook and app hooks merge first, so it runs OUTSIDE this one — the
transaction opens on the caller-scoped client, and `$setAuth(u).$transaction(…)`
passes its own proxy through, so row policies and `auth()` survive into it. And
the announcement happens in `callService` after `runPipeline`, so the write lock
is released before anything fans out to a socket.

`find`/`get` are never wrapped, excluded **by name** the same way the announcement
excludes them — a read taking `BEGIN IMMEDIATE` would serialise every reader. A
service declaring it without a Litestone client **throws naming the service**; a
declared guarantee that quietly does nothing is the failure mode this package
keeps rediscovering. `describe()` reports the resolved list.

**A nested `app.service('x')` call needs no propagation.** Planning assumed it
would escape the transaction; reading the client disproved it — every flavour
shares one write connection and one depth counter, so the inner write lands
inside the outer transaction and its reads see it. Litestone `FJS-244` is what
keeps that true under concurrency, and this feature required it first: it opens a
transaction on every mutating request, which would have made that defect the
normal path rather than a rare one.

**What it does not do.** A transaction rolls back rows, not SMTP. An email an
earlier `after` hook already sent stays sent — that half of `FJS-089` stays open,
and the route to it is the transactional outbox, which turns the effect into a
row that this mechanism can already roll back.

**What it costs.** `BEGIN IMMEDIATE` holds SQLite's single write lock for the
whole pipeline, `after` hooks included. An `after` hook doing network I/O
serialises every write in the app behind it. Off by default for that reason.

Also fixed while testing it: `createBaseService` dropped a `transactional`
declaration, so a service written with the base factory and spread through the
autoloader declared a transaction nobody opened — the same silence that once made
`methods:` do nothing through that factory. 11 tests, against a real Litestone
client rather than a stub, since the whole feature is a claim about
`$transaction`'s behaviour.

## 2026-08-13 — one rate limiter, three adapters

`FJS-017` named three symptoms of "two pipeline systems, one vocabulary". Two
were rate limiting; the third (`apiPrefix` hand-resolved in four files with two
defaults) closed separately as `FJS-012`.

**There were three limiters.** The transport middleware took `limit` / `keyFn` /
`window: 60_000`; the pipeline hook took `max` / `key` / `window: '15 minutes'`;
`@frontierjs/auth` carried a third. Same algorithm, three vocabularies, so what
you learnt from one told you nothing about the next — and they had drifted:
auth's returned before comparing on a fresh bucket, so `max: 0` let one request
through.

**Auth's fork had a stated reason and it was stale.** Its comment said the shared
hook *"operates on ServiceContext, which has `ctx.params.ip`"*. A ServiceContext
has no `params` at all — that is one of the loudest traps in this package's own
docs. The real difference was one accessor: a TransportContext carries `ip` at
the top level, a ServiceContext splits client facts into `ctx.client`.
`clientIp(ctx)` answers for both, and the hook reaches `auth` optionally, because
a sign-in route has no principal by definition. Auth's copy is gone.

`core/rate-limit.ts` owns counting, the window, the sweep, the teardown and the
refusal. The three call sites are adapters over it, differing only in how they
read a key and what they do with the verdict — the transport tier keeps its
`x-ratelimit-*` headers, because it runs where a response is still being
assembled and it is the tier that can count a flood which never reaches a
service. That difference is why the two tiers stay separate.

One vocabulary: **`max` / `window` / `key` / `message` / `skip`**, with `window`
taking a TTL string or milliseconds at both tiers, and `retryAfter` on the 429
from both. **The old names throw rather than being ignored** — a silently dropped
`limit:` leaves `max` undefined, and `count > undefined` is never true, so the
limiter would accept everything and say nothing.

**Middleware and hooks are NOT merged into one concept.** `FJS-D01` refused that
once, and the transport limiter is the argument for keeping them apart.

10 tests, and they assert what no per-copy test could: that the tiers agree.
Baseline 199 → 198.

## 2026-08-13 — one registration per route, one announcement per mutation

Two defects with one shape: **something registered twice, and nothing said so.**

**A duplicate route is now refused by name, at registration.** `Router.add()`
accepted a second registration of the same path in silence, and which copy
survived depended on something the caller cannot see — a FIXED path is written
into a map by `build()` so the LAST one won, while a DYNAMIC one is pushed onto a
list `lookup()` scans in order so the FIRST won and the later handler never ran.
The refusal is keyed on the route's SHAPE rather than its literal path, because
`/a/{id}` and `/a/{name}` accept exactly the same requests and differ only in a
name nothing outside the handler reads. Each segment carries its type: `{}` is a
legal static segment (`PARAM_PATTERN` needs a character between the braces), so a
placeholder spelt `{}` made `/a/{}` collide with `/a/{id}`.

It surfaced as **doubled CORS** — `cors()` registers `OPTIONS /*`, and `fli new`'s
own scaffold called it by hand beside the config entry that installs it at
startup, so every scaffolded app ran doubled CORS from its first boot. The headers
came out right, which is why nobody looked. Closes `FJS-225`, and the same refusal
covers any plugin claiming a path another already owns.

**A service can no longer broadcast twice.** `channel:` is announced by
`callService` at the single announcement point; the exported `publish()` hook
sends its own frame from `after`. Carrying both put the same record on the wire
twice and every subscribed tab applied it twice. The register tracked this as
*"grep before merging"* — a rule nobody can be relied on to follow and no test can
check. `publish()` now marks the hooks it produces, and `svc.pipelines()` refuses
a service carrying both, naming the method. That is the one place the **full**
effective chain is known, so an app-level `after: { all: [publish(…)] }` — the
shape that would double a whole app at once — is caught too. Marked hooks and
never names: an app may call its own hook `publish`, and suppressing a real one on
a name collision would silently stop broadcasting, which is this defect inverted.
Closes `FJS-045`, verified unrealised first — 17 basecamp services use the hook
and none also declares `channel:`.

13 tests. Suites green, typecheck at baseline, `example`: verify + **verify:live**
+ jobs, `basecamp`: verify 271/271.

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

`transport/send-queue.ts` is now the one owner of *put this frame on that socket*:
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
200 frames with the send queue and 98 of 200 without it. 905 pass.

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
