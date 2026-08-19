# Changes — @frontierjs/litestone

## 2026-08-19 — a generated case has to isolate the rule it names (`FJS-351`)

2373 tests, 0 fail. Typecheck clean.

`generateValidationCases` built every case from ONE attribute with no idea what
else sat on the field, and both halves of that were wrong the moment a column
carried two rules.

**A boundary claimed a value the field refused.** `@length(3, 200)` produced
`'xxx'` and `'x'.repeat(200)`, and on an `@email` column neither is an email —
so the write was refused and the runner reported *@length allows this value and
the write was refused*: a correct schema graded as broken. Measured on a
six-field schema, **8 of 12 boundary cases were false, and 4 of 6 fields were
reported broken when nothing was.** The fix a reader reaches for is deleting a
rule from the schema, which is exactly what happened to basecamp's
`Invitation.email` before this landed.

**An invalid case was refused by somebody else's rule and counted as proof of
its own.** `''` on that column is rejected by `@email`, so `@length` could be
deleted from `validate.js` and the check stayed green — and a mutant that
widened it survived, which is the one thing `litestone mutate` exists to catch.
`attempt()` carried the message every case already declared and never compared
it; it does now, and a refusal by the wrong rule is reported as
`rejected-by-another-rule` rather than passing.

**The judge is `validateField`**, newly exported from `core/validate.js` — the
function that decides this on a real write. A table of formats in the generator
would be a second definition of every rule, drifting the moment one is tuned.

**The repair is format-blind.** It grows or trims the factory's own valid
sample and asks the validators whether each candidate passes, so an
`@email @length(_, 200)` boundary comes out as a long local part in front of the
sample's own domain, a `@url` keeps its scheme, and `@startsWith("ORD-")` keeps
its prefix — without this code containing the words *email*, *URL* or *prefix*.
Shrinking works on the sample's alphanumeric RUNS and leaves its punctuation
alone, which is how `email1@example.com` becomes `e@e.c` at five characters.
Which dimension is free depends on the rule: a boundary IS its length, an
invalid `@length` case only has to sit outside the bound, and every other rule's
length is incidental — `@url`'s `'not-a-url'` is nine characters and was refused
by a sibling `@length(10, 60)` until it could be padded.

**What cannot be isolated is reported, never dropped.** `uncheckable` names the
rule, the blocking rules' own messages, and says the case was NOT checked —
because a rule that quietly stops being asked about is this runner's failure
mode one layer up. A lower bound at a format's own floor is the honest example:
the shortest string `@email` accepts is `a@b.c`, so `@length(5, …)` there can
never be violated by anything still an email, and `@length(6, …)` can.

## 2026-08-19 — `$protectedFields`, so an app's own trail can redact (`FJS-154`)

2368 tests, 0 fail. Typecheck clean.

**`db.$protectedFields('secret')` → `{ data: 'encrypted' }`.** The third sibling
of `$checkWhere` / `$checkOrderBy` and the same contract in every respect: an
unknown accessor answers `{}`, and every flavour of client — root, `$setAuth`,
`asSystem`, `$scopedBy` — answers identically, because what a schema DECLARES
protected is not a question about who is asking.

It exists because an application keeps a trail of its own. `@@log(audit)`
redacts `@encrypted` / `@guarded` / `@secret` in its own JSONL and that is
stated as a repo invariant — but basecamp writes "who did what" into an
`AuditEvent` table the UI reads, and the only thing it could do about protected
columns was hold a hand-written list of names that goes stale the first time
somebody adds a `@secret`. One reading of the schema, in the package that owns
the schema.

The value says WHICH protection rather than `true`, because the three are not
interchangeable: `guarded` locks both directions, `encrypted` hides a value from
a non-system reader and stays writable, and `hashed` has no plaintext at all.

## 2026-08-18 — `VersionConflictError` says which two revisions disagreed (`FJS-341`)

2367 tests, 0 fail. Typecheck clean.

The class already carried `expected` and `actual`; nothing downstream could read
them. Junction's error boundary copies `errors` and `retryable` and nothing
else, so the losing editor was told a retryable 409 had happened and never what
moved — which is the difference between *reload and try again* and a screen that
can offer *keep mine* against *take theirs*.

`data = { model, field, expected, actual }`, which is the field junction's
boundary now carries. One line, and the reason it is `data` rather than a new
name is that `FrameworkError.data` already means exactly this.

## 2026-08-17 — atomic update operators, and a rebuild that refuses (`FJS-D27`, `FJS-183`)

2367 tests, 0 fail. Typecheck clean.

**`{ views: { increment: 1 } }` is a write now** — `increment`, `decrement`,
`multiply`, `divide` on a numeric column and `push` on an array one, on `update`
and `updateMany`. Read-modify-write loses one of two concurrent increments and
`@version` only turns that into a conflict the caller has to retry; `UPDATE t SET
views = views + ?` needs no read and cannot race.

The objection was that the payload is otherwise VALUES, so `{ views: {
increment: 1 } }` and `{ addr: { city: 'x' } }` are one shape to a parser. **The
column decides**, as it already does on the where-side between a typed-Json path
and an operator block: a `Json @type(T)` column keeps taking an object, and
everything an operator cannot legally apply to is refused by name — wrong column
type, an operator on a create or an upsert, `divide: 0` (SQLite answers NULL and
raises nothing), two operators on one column, an enum array pushed a non-member,
and a column carrying a bound the operator would escape, since the new value is
computed inside SQLite where `validate()` never sees it.

`push` appends through `json_insert(coalesce(col, '[]'), '$[#]', ?)`. The
coalesce is the load-bearing half: `json_insert(NULL, …)` answers NULL silently,
so a push into a NULL column would drop the value and report success.

**A rebuild that would destroy an app-created trigger or index is BLOCKED.** It
used to name them in a comment above the SQL that destroyed them, which is the
wrong answer for somebody applying a generated migration without reading it —
who is who a generated file is for. The rebuild is commented out with three ways
forward, the same shape an un-defaultable new column already used, and
`autoMigrate` reports `state: 'blocked'` and writes no hash, so it resurfaces
every startup. Re-emitting a captured trigger stays rejected: its body may name a
column the rebuild drops.

## 2026-08-17 — a model is scoped through its parent (`FJS-282`, `FJS-333`)

2349 tests, 0 fail. Typecheck clean.

**`check()` is a real lookup outside a WHERE.** It answered `true`
conservatively in the JS evaluator, so `@@deny('all', !check(parent))` held for
read, update and delete and permitted a cross-tenant CREATE in silence — the
reason `tenancy { strategy row }` could not generate the rule and left 22 of
basecamp's models to hand-written ones. The foreign key is in the data being
written and `buildFilterSql` already builds the target's own filter, so the same
SQL runs uncorrelated: `SELECT 1 FROM "<target>" WHERE "<referencedKey>" = ? AND
(<target policy>) LIMIT 1`. Reads go through `ctx.readDb`, which serves the write
connection while a transaction is open — without that a parent and child created
together deny the child. An **absent** foreign key allows, the same answer the
tenant column already gives on create. `evalJs` takes the containing operation
now, so a bare `check()` asks the right question of the target.

**Tenancy generates it.** One `@@deny(read, update, delete, create, !check(rel))`
per SCOPED PARENT — and that is why there is nothing to choose. Denies are AND'd,
so a model with two scoped parents must satisfy both: the narrowing answer, and
the direction tenancy always takes. Picking one parent and ignoring the other
would widen, under a rule nobody could predict. Transitive by fixpoint, so a
grandchild is scoped once its parent is; self-relations are skipped;
`check(rel, 'read')` is stated rather than inherited, because the question is
*is that parent mine* and never *may I create that parent*.

`@@tenant(via: rel)` narrows to one named relation, and is refused if it names
something that is not a to-one relation or a parent that is not itself scoped.
The *N models are NOT scoped* report now names only the models with neither a
column nor a scoped parent, and a second line names what was delegated.

**`check()` had never worked on a model whose table is snake_cased** (`FJS-333`).
The `EXISTS` named the MODEL where it had to name the outer table, so
`model LineItem` produced `"LineItem"."orgId"` against table `line_item` and
SQLite answered `no such column`. Every single-word model hid it — identifiers
match case-insensitively, so `"Order"` finds `order`.

## 2026-08-17 — three refusals that name the thing (`FJS-206`, `FJS-207`, `FJS-332`)

2332 tests, 0 fail. Typecheck clean.

**A failing batch says which row.** `UNIQUE constraint failed: post.slug` out of a
500-row import named the column and never the row, so finding it meant bisecting
the batch by hand — and the loop already had the index. The message now opens
`data[i] of n`, names the values that collided, and says **nothing in the batch
was written**, which is true and is the difference between re-running the import
and hunting for partial rows. `batchIndex`/`batchSize` are on the error for a
caller that would rather not parse prose. The error is annotated rather than
wrapped: its class carries the status past the API boundary, and a wrapper would
flatten `SoftDeletedUniqueError`'s 409 into an unclassified 500. The values are
redacted the way the audit trail redacts them, because a `@unique` column may be
`@encrypted`. Three sites had the same silence — the insert loop, the
row-building map above it, and `upsertMany`, whose loop carried no `try` at all.

**A `Json` filter says whether the column has a shape.** `{ meta: { tier: … } }`
on an untyped column threw `Unknown where operator "tier"`, which sends the
reader after a misspelling; it now says the column is untyped Json and gives both
routes, `@type(...)` or `$raw` with `json_extract`. The mirror on a typed column
threw `Unknown field 'has' on type Address` — naming the type, calling an
operator a field, and never naming the column. `WHERE_OPS` is the one set of what
an operator is, so the typed walk can tell a sub-key from one.

**`@unique` over a randomly-encrypted column is refused.** Found probing the
first of these with a `@unique @encrypted` fixture that would not conflict: the
constraint is over the stored bytes and a random IV makes every write of one
value different, so it is declared, built, and can never fire. Measured — two
creates, two rows, no error. `@unique` and `@@unique([...])` naming such a column
are refused at parse now, beside the `@hashed` conflict rules;
`@encrypted(deterministic: true)` and `@hashed` are the two ways through.

## 2026-08-17 — a bulk write counts its own rows, not its triggers' (`FJS-320`)

2320 tests, 0 fail. Typecheck clean.

`{ count }` on a bulk write meant *rows this statement addressed* and did not
say so. bun:sqlite's `.changes` is a total-changes DELTA, not
`sqlite3_changes()`, so it also counts what a trigger or a foreign-key action
wrote inside the same statement. Filed against `@@fts`, where one updated row
answered 17; the wider case is `updatedAt`, which is a SQL trigger here, so
every model carrying the column doubled its count, and a `deleteMany` naming
one parent answered 4 for its three cascaded children. A model with no trigger
and no cascade was the only one ever right.

`rowsChanged(db)` is the one answer now — `SELECT changes()` read off the same
connection with no write in between, which counts only the rows the statement
itself named. It replaces `.changes` wherever the number means rows:
`updateMany`, both halves of `removeMany`, `deleteMany`, the two single-row
`select: false` paths whose telemetry carried the same inflation, and
`retention.js`'s log line. The `RETURNING` paths already counted rows and are
untouched; `createMany` and `upsertMany` count iterations.

The number leaves the Data realm — junction hands it to the browser and a live
store's `changed` event carries it — so a caller comparing it against what they
asked for saw a write that touched rows nobody named.

`test/bulk-count.test.ts` holds it: nine cases over five models — fts,
`updatedAt`, no trigger at all, soft delete, cascade, a write that matched
nothing, inside a transaction, and `announce: 'rows'` agreeing with the default.

## 2026-08-17 — `@transient`: the payload key that is not a column (`FJS-D23`)

2311 tests + 16 new, 0 fail.

The mirror of `@computed` — a field with no column, written by the caller and
never read back, where `@computed` is one that is read and never written. The
mirror is the design, not a slogan: it is emitted into the WRITE modes of the
generated JSON Schema (`writeOnly`, `x-litestone-kind: 'transient'`) and absent
from the read ones, out of the row type and out of `Where` in generated types,
and out of the DDL. Twenty-three attributes that describe storage, derivation or
a read are refused beside it by name, as is a field `@allow` (the rule would be
evaluated at a boundary the value never reaches) and a `@@index`/`@@unique`
naming it.

At the Data boundary it is refused by name in a write, a `where`, an `orderBy`,
an aggregate and a policy predicate, each with the reason. All five matter for
one reason: SQLite reads a double-quoted identifier it cannot bind as a string
LITERAL, so a filter over a column that does not exist matches every row or none
and reports nothing.

**`isStoredField` in `ddl.js` is now the one answer to what becomes a column.**
`CREATE TABLE` and the rebuild's `INSERT … SELECT` were each carrying their own
list and had already drifted: the rebuild's copied `@computed`, `@from` and
`@derived` fields, which is the string-literal hazard above inside a migration.

`generateValidationCases` skips a transient field — its rules are real and this
is not the layer that holds them, so every generated case would write a value
the boundary refuses and read as a broken rule. The API is where they run, and
`@frontierjs/testing` is the tier that can reach it.

Ruling in `DECISIONS.md` § API design.

## 2026-08-17 — `$inTransaction`, on every flavour of client (`FJS-D35`)

2295 tests, 0 fail. Typecheck clean.

```js
db.$inTransaction              // → false
await db.$transaction(async () => db.$inTransaction)   // → true
```

For a caller whose correctness depends on being inside one — junction's outbox
row, which is only worth writing if it rolls back with the write it belongs to.
That caller cannot ask the service declaration instead: `transactional:` is a
statement about a method, and a hook can run against a method it does not name.

A fact about the CONNECTION, so it is the same answer on every flavour — a
scoped client, the system bypass and `$scopedBy` share one write connection and
one depth counter. `litestone types` emits it too, so a generated client
declares it; `AnyLitestoneClient` deliberately does not (adding it there makes
every already-generated client unassignable, which is `FJS-018`).

## 2026-08-17 — three declarations that did not match the runtime (`FJS-034`)

2295 tests, 0 fail. Typecheck clean. `src/index.d.ts` only — no behaviour moved.

Found from junction's side, driving its typecheck baseline to zero: its examples
hold a real client, and each of these was an example that could not compile
against a thing that works.

- **`LitestoneClient.$schema` is a `LitestoneSchema`.** It was `unknown`, and
  `generateJsonSchema(db.$schema)` is the documented line — so the documented
  line was a documented cast. `AnyLitestoneClient` keeps `unknown` on purpose: a
  generated client declares a `$schema` of its own, and naming a shape there
  makes the generated flavour unassignable again, which is the failure that
  interface exists to end (`FJS-018`).
- **`TableClient`'s last four parameters default off the row.** Naming an
  accessor by hand — a test, or an example whose schema is a string with no
  `litestone types` run behind it — cost five type arguments, so examples wrote
  none and stayed untyped. It costs one now.
- **`FileStorageOptions` declares `localPath` / `localUrl` / `localPort`.**
  `storage/providers/local.js` reads all three and nothing declared them, so the
  local branch of every dev storage config was a type error.


## 2026-08-16 — the generated types name the services too (`FJS-018`)

2295 tests (3 new), 0 fail. Typecheck clean.

`generateTypeScript` now emits **`ServiceTypes`** — service name → row type, one
entry per model. The key is the plural, from `@frontierjs/toolbelt/inflect`, the
same table the accessor and Sierra's registry read, so `Person` is `people` and
a name derived here matches the model derived back from it (Invariant 2).

`--augment junction` adds the module augmentation that registers the map with
`@frontierjs/junction/client`, which is what makes `client.service('posts')`
answer this schema's row in a browser. Behind a flag because an augmentation
names a package: emitted unconditionally it is a type error in every app that
installed litestone alone.

Two things fell out of using it. **`createClient` is generic** —
`createClient<Db>({ … })`, where `Db` is the generated client — because the
alternative is an assertion at every call site, which is exactly the
hand-written table shape the generator exists to replace. And the tools take
**`AnyLitestoneClient`** now: the hand-written `LitestoneClient` in `index.d.ts`
reaches its tables through an index signature, a generated one has a typed
accessor per model and therefore none, and the second is not assignable to the
first — so an app holding generated types could not call `autoMigrate(db)` at
all. `apply`, `autoMigrate`, `runSeeder`, `Seeder`, `Factory` and
`defineFactory` name the wider type.

## 2026-08-16 — the hook runner gets one call site (`FJS-288`)

2292 tests, 0 fail.

`hooks.before.all` declared sixteen operations and reached four of them. The
two sets are the contract — `expand('all')` iterates `SETTER_OPS ∪ GETTER_OPS` —
and eleven of those names had no call site, so registering on `deleteMany` or on
`setters` was silent in both directions: the hook never ran, and nothing said it
would not. An audit or a stamp registered on `all` missed every bulk write,
which is exactly the write a per-row `update` hook was covering for. `exists`
was in neither set, so `all` missed it too.

The cause was five hand-written hook pairs living inside the methods. There is
one now: `installHooks(table, ctx, modelName)` wraps a built table once, reading
the same two sets, and `makeTable` returns through it.

**A hook fires exactly once per call the caller made, named for the method they
named** — which is what the wrapper's two `this` bindings decide:

- a hooked operation runs against the RAW table, so its own internal calls
  (`upsert` → `create`/`update`, `findMany({recursive})` → `findMany`) do not
  announce a second time
- everything else runs against the wrapper, so a delegating helper
  (`transition` → `update`, `findFirstOrThrow` → `findFirst`) still reaches the
  hook of the operation it delegates to

Three consequences worth knowing before you upgrade a hook:

- **hooks are the outermost layer now.** A before hook sees the arguments as the
  caller wrote them, ahead of the plugin door and ahead of any stamping this
  file does — `@sequence` values and nested-write extraction used to happen
  first on `create`.
- **an `upsert` that inserts fires `upsert`**, where the nested `create` used to
  fire `create`. One call, one hook run.
- **an after hook on `update` can replace the result**, which it silently could
  not: the result was assigned to the context and the return value read past it.

`search` is the one method that is not `(argsObject)`, so its context carries
`{ query, ...opts }` — a before hook rewriting `args.query` rewrites the search
text.

Seventeen operations × before/after, each asserted to fire once with nothing
else, in `test/litestone.test.ts` § hook coverage. A new operation belongs in
that grid; a missing row fails rather than being skipped.

Unblocks `FJS-D10`'s `setters`/`getters` → `read`/`write` rename, which was held
because an accurate name on a broken mechanism hides the hole. Filed while
measuring this: `FJS-320`, a bulk write on an `@@fts` model reporting the FTS
triggers' work in its `count`.



## 2026-08-16 — `announce`: the dial on what a bulk write says (`FJS-D34`)

2289 tests, 0 fail.

`FJS-307` made the collection announcement always correct and always coarse: a
three-row cancel makes every subscribed tab reload its page. `announce` is the
opt-in that buys precision back.

```js
db.order.updateMany({ where, data, announce: 'rows' })   // one event per row
db.event.deleteMany({ where, announce: 'none' })         // silent, deliberately
createClient({ …, announce: 'collection' })              // the floor
```

**Per CALL, with a client-level floor** — precedence option → client →
`collection`, the shape `resolveTenancy` already uses one realm over. It is the
call and not the model because the call site is the only place the batch size is
knowable: one `Order` model carries both a three-row cancel and a two-million-row
purge, and a model-level flag would materialise the purge. It is not decidable by
size either — the count is unknowable before the statement without a second
query, so this is declared rather than guessed.

**What `rows` costs is memory proportional to the batch**, which is the whole
reason it is not the default. What it does not cost is a query: the three
statement-shaped methods already append `RETURNING *` on a logged model, so the
change is one condition wide and free where a trail is already being written.
And it is **ANDed with the audience** — an app that opts in with nobody listening
still takes no `RETURNING`, the same guard that keeps the write path free for an
app that taps nothing.

`upsertMany` gets the better answer at this tier: the create/update split is
already computed for the trail, so each half announces truthfully instead of the
whole batch calling itself an update, which is the compromise the collection form
has to make.

**An announced bulk row goes through `read()`.** Straight off `RETURNING` it
still carries `@guarded` and `@encrypted` columns that every other event path
strips, and a subscriber is not a privileged reader. `announceBulk` is the one
owner of the three-way branch so that cannot be got right at four sites and wrong
at the fifth.

Refusals are loud in both directions. An unknown value is `InvalidAnnounceError`
(400) naming the three legal ones, thrown **before** the statement — `announce:
'row'` is somebody who wanted per-row announcements, and quietly giving them the
coarse one is the class of bug `FJS-307` closed. `announce: 'rows'` on a jsonl
model is refused by name too: append-only, no `RETURNING`, no row that could ever
be announced.


## 2026-08-16 — every write announces, and says whether it can name the row (`FJS-307`)

2279 tests, 0 fail. `test/write-events.test.ts` is new and is the point.

**Seven of eleven write methods announced nothing, and never had.** Measured one
call each against a real client: `createMany`, `updateMany`, `upsertMany`,
`removeMany`, `deleteMany`, `delete` and `restore`. The filing said `restore`
fired and did not mention `upsertMany` — running it said otherwise, which is why
this starts with a grid rather than a fix.

A write event now carries **`scope`**, and it is stated rather than inferred:

- `row` — one row changed. `result` is that row, or `null` where `select: false`
  skipped the RETURNING.
- `collection` — `count` rows matching `where` changed, and the statement never
  built them.

Reading the discriminator off `result` was the tempting shortcut and it is
wrong in both directions. `result: null` already had two meanings, and the
second one — a `select: false` write, which is one row nobody can name — was
being emitted and silently dropped a layer up. That case is the argument for
the shape: it is not a bulk problem, it is the same problem one method over.

`delete` and `restore` had their rows the whole time — `delete` from its
pre-DELETE SELECT, whose sibling `remove` fires from the same region, and
`restore` from a RETURNING it already shapes and hands back — so both announce
per row, as `remove` and `update`, matching what the audit trail already calls
them. The four bulk methods announce a collection. `upsertMany` announces
`update`, because the create/update split is known only on a logged model and
`create` would be wrong for the conflicting majority.

**A write that matched nothing announces nothing.** A filter that hit no rows
sending every open tab back to the server is worse than silence, and it is the
one shape a count-based announcement can get gratuitously wrong.

The audience guard leads in both helpers, so an app that subscribes to nothing
does not build the payload — the same rule the `$tapEvents` fast path already
held. What per-row announcement for a bulk write would cost, and who should ask
for it, is `FJS-D34`.


## 2026-08-16 — `$tapEvents(fn)`: subscribing to writes after the client exists (`FJS-D04`, `FJS-010`)

2243 tests, 0 fail.

`onEvent` is fixed at `createClient`, so a layer handed a finished client had no
way to hear about a write. That is the whole of why an `asSystem()` write in a
job announced nothing to anybody: Junction is constructed after the client it is
given. `$tapEvents(fn)` is `$tapQuery`'s shape one event kind over — add to a
Set, get an unsubscribe back — and it closes `FJS-D04` in about the two lines
that ruling predicted.

**The listener Set is shared by reference**, sitting beside `_queryListeners`
for the same stated reason: `asSystem()`, `$setAuth()` and `$scopedBy()` each
SPREAD the context object, and a per-copy Set would mean a subscriber attached
to the root never hears the one write nothing else announces.

**The part the mirror had to add is the fast-path guard.** A query tap is only
read where a query fires, but an event tap has to be visible to the upsert fast
path, which skips the read-then-write split when nothing needs it — `!emitter`
was one of its conditions. Making a tap set `emitter` would have cost every app
that subscribes a measured ~6x on that path; instead `fireEvent` consults both
audiences and the guard reads `!emitter && !ctx._eventListeners.size`, so an app
that taps nothing is exactly as fast as before.

A tap's payload carries `event` folded in, because a `transition` has no
`operation` and a subscriber handling every kind would otherwise have to
re-derive the name. Dispatch is deferred and swallowed like the emitter's own:
a subscriber is an Observer and may not fail the write that announced it.

**What it does NOT cover is now filed rather than assumed** — `FJS-307`. Writing
the coverage grid found that `createMany`, `updateMany`, `removeMany`, `delete`
and `deleteMany` fire nothing, and never did; `$tapEvents` inherits `onEvent`'s
reach exactly, bulk boundary included.


## 2026-08-16 — a capability the schema does not declare is a 400, and it is said out loud (`FJS-292`, `FJS-293`)

2241 tests (7 new), typecheck clean.

**Two failures with one cause, answered in opposite directions.** A caller asked
a model for something its `.lite` never opted into: a METHOD threw a bare
`Error`, which `toFrameworkError` has no name entry for, so `?$search=widget` on
a model with no `@@fts` came back **500 GeneralError** — the server saying it
broke about a request it understood perfectly. A FLAG was dropped in silence, so
`onlyDeleted` on a model with no `@@softDelete` answered the **live rows** —
measured on `example`, where `/api/orders` and `/api/orders?$onlyDeleted=true`
both answered `total: 3`.

`CapabilityNotDeclaredError` is both: 400, `retryable: false`, carrying `model`,
`asked` and `requires`, and naming the attribute that would make the request
legal. `search()`, `optimizeFts()`, `restore()` and `transition()` throw it, and
so do `onlyDeleted` / `onlyTemplates` on a model that declares neither attribute.

**`withDeleted` and `withTemplates` deliberately do not.** They ask to WIDEN, and
on a model that hides nothing the full row set already IS everything — the answer
is right rather than accidentally right. Generic code that does not know the
model asks exactly this: Studio's row browser passes `withDeleted: true` on every
row it opens, and an admin screen with a *show deleted* toggle is the same shape.
Only the flag that cannot be satisfied at all refuses.

An include takes the same flags and reaches neither mode function — it builds
its own SQL — so `include: { books: { onlyDeleted: true } }` against a target
with no `@@softDelete` refused nowhere and answered that target's live rows. It
refuses now, naming the TARGET model.

**The silence had a mechanical cause worth naming.** `sdMode()` answered `'live'`
for a model with no soft delete, and every caller guarded the call with
`softDelete ? injectSoftDeleteFilter(…, sdMode(args)) : where` — so on exactly
the models that could not honour a flag, the function that could have refused it
was never called. `applySdFilter(where, args)` is the fix and the symmetry:
`applyHtFilter`'s sibling, asked on every read, refusing before it decides
whether there is a filter to apply. Two inline ternaries in `findManyCursor` and
`search()` were computing the mode by hand and are now the same call.

`false` is not asking. The flags default to `false` all over the client, so only
a truthy value is ever looked at.


## 2026-08-16 — tenancy is declared in the seed (`FJS-D05`)

2234 tests (28 new, `test/tenancy.test.ts`), typecheck clean.

**A `tenancy { }` block, beside `database { }`.** Two strategies:
`strategy database` is the file-per-tenant registry that already existed, now
configured from the schema; `strategy row` is one database and a tenant column,
which was not a framework concept in any form. Everything that needs to know
reads one resolution — `resolveTenancy(schema, { schemaPath })`, published as
`db.$tenancy` on every flavour of client and as `registry.tenancy` — and
precedence is **option → declaration → default**, stated once in
`src/core/tenancy.js`.

What that closes: db-per-tenant's configuration lived in three places that could
disagree — a `createTenantRegistry()` call, a `tenants:` slice in
`litestone.config.js` the CLI read three keys of (`dir`, `registry`,
`migrationsDir` — never the pool size or the key), and nothing in the schema.
`litestone tenant create` and the running app could each be correct about a
different directory. `createTenantRegistry({ path: './db/schema.lite' })` is now
the whole call, and the CLI and Studio resolve the same way.

**Row tenancy desugars into `@@deny`, and that is the correctness argument
rather than a style choice.** `@@allow` rules are OR'd within an operation, so
adding one to a model that already declares `@@allow('read', ownerId ==
auth().id)` *widens* its reads to every row in the tenant — a tenancy feature
that grants access. Deny overrides every allow and applies to a model declaring
no policy at all. Two rules per scoped model, because `checkCreatePolicy` runs
BEFORE `applyAuthDefaults`: on create the column the `@default(auth().<claim>)`
stamp is about to fill is legitimately absent, on read a row holding no tenant
belongs to nobody. Get the ordering wrong one way and every create is refused;
the other way and orphan rows are visible to everybody. Both are pinned against
a real client, because a policy that admits everything and a policy that is not
applied at all look identical from one side.

**What the block cannot judge is answered per model.** `@@tenant(none)` for a
model that spans tenants, `@@tenant(column: "x")` for one scoped differently,
and a model declaring neither is **reported once, by name** — cross-tenant data
is sometimes a plan table and sometimes the column somebody forgot, and only the
app can tell. `jsonl`/`logger` models are never scoped: no policy engine there,
so a rule would read as enforcement and not be it. The pre-existing
*@@deny with no @@allow* warning now ignores generated rules, or it would fire
once per model on a schema doing the right thing.

Deferred with a reason: a model reached only through its parent
(`check(parent)`) is not generated — `check()` is conservative-allow on create,
so the rule would hold for reads and permit a cross-tenant create in silence
(`FJS-282`).

`docs/multi-tenancy.md` is the reference.


## 2026-08-16 — migrations, second tier (`FJS-D09`)

Three questions left open when the executor took ownership of the transaction,
answered together because each is a way a migration reports success and loses
something.

**There is no `down`, and now there is a way back instead.** A generated down
cannot undo the migration it reverses — a rebuild is a `DROP TABLE`, so the
inverse of *drop a column* is *invent the values it held* — and one that runs,
succeeds and leaves a database that only looks restored is worse than none.
`litestone migrate apply --backup[=dir]` copies **every** SQLite database the
schema declares before the **first** one is migrated, and refuses to migrate
anything if a copy fails. Off by default; a deploy that wants a multi-gigabyte
copy says so. Without it, apply names what it cannot take back — a pending file
that drops a table, and every `.js` migration, whose contents nothing here can
read. `src/core/backup.js` is now the one owner of copying a live SQLite file;
`db.$backup` calls it too, because the CLI holds a raw handle and the client
holds a registry connection, and *is this copy safe under an open WAL* must not
have two answers.

**A rebuild asserts its own row count before it drops the original.** The gap
was that a copy reading fewer rows than the original holds is an error to
nobody: SQLite inserted what it was asked for, and the runner saw a statement
return. Measured by editing a generated copy step — which the file's own header
invites — the rows were gone one statement later and the run reported ✓. SQLite
has no assertion (`RAISE()` is trigger-body only), so the comparison is a CHECK
on a one-row temp table whose constraint NAME is the message: `CHECK constraint
failed: rebuild of post lost rows`. It aborts inside the migration's
transaction. Emitted even when nothing is copied, which is the case it changes
most — a rebuild sharing no column name with the old table used to empty it
under a comment reading *nothing to copy*.

**A migration is named after the last file in its directory, not after the
clock.** Filename order is apply order and the stamp is second-granular, so two
migrations made inside one second either overwrote each other (same label) or
applied alphabetically (`evolve` before `initial`). `nextMigrationName` steps
the stamp past the highest one already in the directory. Loosening the name
pattern was not available: the 14-digit prefix is where the ordering guarantee
comes from.

`DECISIONS.md` § Migrations. Tests in `test/migrations-fixes.test.ts` (6 new,
each verified by breaking the fix) and `test/cli-smoke.test.ts`.

## 2026-08-15 — a plugin has an identity, and keeps its name (`FJS-D19`)

`Plugin` gets a `name`, defaulting to the class name — right for every plugin
anyone writes here and free — with a stated `name = '…'` field winning, because a
minifier rewrites `constructor.name` and a bundled app would report `t`.
`db.$plugins` lists what is installed, in run order, on **every flavour of
client**: what is installed does not vary with auth. Its first useful answer is
the one nobody could get before — a gated schema auto-installs `GatePlugin`, so
what you passed is not what is running, and it comes last.

**The other half of that row was a rename, and it is refused.**
`IDEAS/one-mental-model.md` argued that this package's Plugin is really a *Hook*
because it intercepts queries. Tested against the three that exist: `GatePlugin`
is access control, `FileStorage` is a storage capability, `ExternalRefPlugin`
backs a field with external data — each attaches a capability, holds
configuration and has an `onInit` lifecycle, which is Junction's definition of
Plugin exactly. And this package **already has `hooks`**, one option key away, so
the rename would have collided with a live and differently shaped concept inside
the same `createClient` call.

What actually differs between the realms is the interception surface — eight
`on*` methods here, four lifecycle methods there — and that is a realm
difference, not a concept one: a Data-realm plugin intercepts queries because
queries are what the Data boundary owns. The finding mistook the mental model
working for the mental model breaking.

Ordering is the part that should still converge, and it did not need a rename to
say so: when this grows one it takes Junction's `requires: string[]` rather than
inventing `after`/`priority` beside it.

## 2026-08-15 — the console boots at a gate level (wave 4.23)

`litestone repl --as alice@example.com`, `--level 4`, `--gate ./api/gate.ts`,
with `fli tinker` over it. `db` is the standing you asked for and `sys` is
`asSystem()` — reachable on purpose, because refusing it means people run a
one-off script instead, which is the same power with none of this in front of it.

**The engine was already built, twice, and the record said it did not exist.**
`litestone repl` shipped and worked; Studio's `POST /api/repl` already evaluated
arbitrary expressions against `activeDb.$setAuth(pickedUser)` with `sys` bound
separately and every statement tapped through `$tapQuery`. What was missing was
the terminal, and one thing neither had.

**A subprocess REPL cannot say what it is running as**, and everything this
command claims rests on that. It drove `bun repl` through a temp file, `.load`
and two fixed sleeps; it is hosted here now over `node:readline`, so the standing
is in the prompt on every line rather than in a banner you scrolled past. Losing
the subprocess also removed the restriction that the REPL could not run from a
standalone binary.

**`--gate` is the flag the feature turned out to need.** Without it the console
grades with `FrontierGateGetLevel`, which is the default and not necessarily what
the app installed — and *refuses exactly what that person is refused* is false
the moment the two disagree. Measured on `example`: the default grades
`ops@acme.test` at 3 (CREATOR), the app's own `shopGateLevel` grades the same row
at 4 (USER), and `Order` is `@@gate("0.4.4.5")` — so a create is refused in the
console and permitted in the app. The banner names which resolver answered.

**`--as` and `--level` stay separate**, the split `createTestEnv` keeps between
`actingAs` and `atLevel`: one runs a resolver over a real row, the other fixes
the answer, and a ladder walked with the second says nothing about whether the
first works. A `--level` standing has no `auth()`, so every `auth().id ==` row
policy matches nothing and its model answers an empty list rather than refusing —
said out loud, because the two are indistinguishable from the result.

Where a schema marks no `@@auth` model and has no `User`, `--as` refuses and asks
(`--as Customer:ops@acme.test`) rather than guessing which table holds people.

**A REPL has to serialise its lines and `rl.pause()` does not do it.** Pausing
does not hold back lines readline already buffered, so a pasted block ran every
handler at once and the statements finished in whatever order their awaits did.
Against a database that is writes landing in an order nobody wrote. 16 tests,
the two ordering ones verified by breaking the implementation.

`src/tools/repl-server.js` is gone — it was the preload for the subprocess.

## 2026-08-15 — `@derived(expr)` (FJS-233)

A value computed in SQL from the row's own columns, so unlike `@computed` — a JS
function SQLite has never heard of — it can be **filtered and sorted by**:

```
model Task {
  overdue Boolean @derived(dueAt < now() && completedAt == null)
  urgency Int     @derived(priority > 8 ? 3 : priority > 5 ? 2 : 1)
}
```
```js
db.task.findMany({ where: { overdue: true }, orderBy: { urgency: 'desc' } })
```

**Server-computed only. The schema ships a flag, not the expression.** A
consumer needs two facts and gets exactly two: `readOnly` and
`x-litestone-kind: 'derived'` say do not write this, and
`x-litestone-volatile: 'clock'` says the value goes stale on its own — no write,
no event, nothing to announce it. Shipping the expression would invite a third
implementation of the language in a browser, beside `compileSql` and `evalJs`;
the server's answer is the only one, and the flag says how long to trust it.

**It rides `@from`'s seam**, built into the same map rather than beside it, and
that is the whole reason it reaches every read: the query pipeline, `search()`,
`findManyCursor`, all three include shapes, `select`, `distinct`,
`findManyAndCount`. A seventh site that forgot it would be silent, the way a
forgotten `@from` is. It carries no parameters — the expression compiles once at
startup and `now()` becomes SQLite's own clock, which SQLite fixes for the
duration of a statement, so every occurrence is one instant.

`aggregate` and `groupBy` build their own SELECTs and needed the expression
substituted where a bare column name goes. Without it `MAX("urgency")` reaches
SQLite as a quoted identifier it reads as a string CONSTANT and answers
`'urgency'` — FJS-202 arriving through a new field kind, one day after that row
was closed.

**`auth()` and `check()` are refused, and the refusal names `@@scope`.** A
derived field is one value for the ROW; per-caller is a different tier, and
keeping it static is what lets the expression compile once. Also refused: a
field that is not on the model, and one derived field reading another.

**The declared type is checked against the branches**, which is the obligation
the ternary brought with it (FJS-234). Branches that disagree, a `Boolean` field
whose expression produces an `Int`, and an enum-typed field naming a value that
is not a member are all schema errors rather than rows that read back something
no consumer expects. Inference is partial on purpose — unknown never fails,
because a type checker that guesses is worse than one that is quiet.


## 2026-08-15 — a ternary in the policy language (FJS-234)

`cond ? a : b`, binding looser than `||` and **right-associative**, so
`a ? x : b ? y : z` nests into the else — a four-value ladder with no CASE
keyword. Both branches parse as a full ternary, which is unambiguous because
`?` and `:` bracket the middle.

Two obligations, because this is where the language stops being predicate-only
and starts producing **values**:

**It lands in both compilers** — `CASE WHEN … THEN … ELSE … END` in `compileSql`
with the params pushed in emission order, `?:` in `evalJs`. A form in one and
not the other is FJS-195 repeating. The first draft landed in neither: an
insertion aimed at `evalJs` matched an identical line in a helper added earlier
the same day, so every create was allowed and the SQL half was doing all the
work. Caught by running it, not by reading it.

**It is gradeable.** `verifyRowPolicies` compiles the read policy into a WHERE
and grades it against the JS evaluator, and it could not see a ternary at all:
its seeder walks the expression for interesting values and had no case for one,
so every row landed on the same side and the policy was reported ungraded rather
than passing. Verified by swapping the branches in one half and watching it fail.

**A parenthesised group is now an operand on both sides of a comparison.** Only
the left side took one, so `ownerId == (open ? auth().id : auth().adminId)` — a
ternary choosing which value to compare against, which is most of what a ternary
is for here — was a parse error on the right and legal on the left. Harmless
while the language was predicate-only; in the way the moment it produces values.

**An ordering comparison is seeded on both sides of its literal**, which is not
about ternaries and was found through one. `level > 5` seeded `level = 5` — the
EXCLUDED side — so the only admitted rows were whatever the factory happened to
generate. A policy graded by luck reports *all rows on one side* the day the
factory changes, and until then grades nothing.


## 2026-08-15 — the permission diff: `litestone access --from <ref>` (wave 4.3)

**What did this branch do to who may do what.** `--from` turns the access
command from a snapshot writer into a question, graded `widens` / `narrows` /
`undecidable`, over gates, row policies, field-level `@allow`, `@guarded` /
`@encrypted` / `@secret` and transition gates. `--strict` exits 1 on a widening,
and `--json` answers the diff. Nothing is written. `bun run ci`'s new `access`
phase runs it per app against the base ref and prints the result.

**The obvious implementation was wrong, and it is the reason this is one
function rather than a new module.** `classifyPivot` already compared two
release surfaces, so pointing it at a base ref looks like the whole job — but it
grades *can Release N-1 and N serve one database*, and that axis is close to
inverted from the reviewer's. On the five-part widening in
`test/release.test.ts`, **every finding is an `expand`** and the single change
that narrows is the only `contract`: removing a `@@gate` costs the previous
release nothing and is the widest thing a schema change can do. So a finding now
carries `severity` for the deploy and, where it is about access, an `access`
direction; `classifyAccess` is a second grading of one walk, because two walks
over one set of declarations is how two answers to one question drift apart.

**A field-level `@allow` was absent from the release surface entirely**, so
`release:check` was blind to it too. It is the shape guarding `isSystemAdmin`,
`role` and `emailVerified` — the columns a permission diff exists to watch — and
it is a compatibility change as well as a permission one (adding one takes the
column out of the answers N-1 reads), so both axes gained it. Grouped by the
operations it names, exactly as `@@allow` is one level up, so an edited predicate
is one *undecidable* finding rather than a removal and an addition that read as
widening and narrowing at once. `release.snapshot.md` gains the rules in its
Notes column, with `|` escaped — a policy expression legitimately contains `||`,
which ends a markdown cell and silently drops the rest of the row.

**A `@@transitions` change has no fixed direction.** The first transition
declared on a free enum column refuses every other move; the second permits one
more. The two arrive as one added row and are counted per field instead.

A predicate whose text moved is reported undecidable on both axes. Two
expressions are not comparable by reading them, and the guess is the one that
ships.

## 2026-08-15 — `@@scope` and `orderBy: { $raw }` (FJS-228, FJS-230)

**`orderBy: { $raw: sql`…` }`** is the escape hatch `where` has had all along
and the sort side did not. Everything monotonic in a stored column already
sorts; what does not — *snoozed last regardless of due date*, a weighted score —
could not be said at all.

The fragment is the whole ORDER BY tail, direction included, because a sort no
builder can express usually needs several keys in an order only the caller
knows, and it composes with ordinary keys in the position it is written. **A
plain string is refused by name**: the `sql` tag's static text is the app
author's and its interpolations are bound, so a bare string is precisely how a
caller-supplied one would arrive. Refused where it cannot mean anything — with a
cursor (which reads every sort key's value back off the last row, and an
expression is not a column) and on `groupBy` (whose ORDER BY is over group keys
and aggregates).

Its parameters travel in their own array spliced in at the ORDER BY rather than
into the statement's as it is built: positional binds make the order the
correctness, and ORDER BY comes after both the WHERE and the row policy ANDed
onto it. FJS-215 was the same lesson.

**`@@scope(name, expr)`** is a named predicate in the expression language
`@@allow` already uses, asked for as `where: { $scope: 'overdue' }` — the policy
compiler named and made explicit rather than implicit and always-on.

It exists although `createClient({ scopes })` already chains, and the reason is
the deciding one: **a browser cannot invoke `db.task.overdue()`.** A client
sends a `where` OBJECT over HTTP, so a scope declared in JavaScript is
server-only and `$scope` is the one spelling that travels.

Implemented by desugaring `$scope` into `$raw` before the where is built, rather
than adding a case to the where builder. That is what makes it compose for free:
`{ $scope: 'overdue', status: 'open' }` conjoins, a scope nested under
`AND`/`OR`/`NOT` nests, several names AND, and the parameters land where
`$raw`'s already do — one owner of each rule instead of a second implementation.
A disjunction is written INSIDE a scope, where both compilers can see it.

Invariant 8 at the one site that invites breaking it: `$scope`'s value is
caller-supplied, and it is a KEY looked up in the table the schema declared.
Nothing a caller sends is interpolated, an unknown name is refused before any
SQL is built with the declared names listed, and `db.$scopes(accessor)`
publishes that list as source text — the same list `$checkWhere` validates
against, on every flavour of client, because filterability is a fact about the
schema.

**A policy naming a column the model does not have is now refused at startup**,
which `@@allow` needed too and never had. It reached SQLite as `"nope" > 1`,
which resolves the unresolvable identifier as a string CONSTANT — so the
predicate compared two literals and the filter silently admitted or excluded
every row. Same fallback as FJS-202, reached from the schema instead of from a
query.


## 2026-08-15 — a soft-deleted row keeps its @unique slot (FJS-204, FJS-278)

`create` a row, `remove` it, `count()` answers 0 — and creating the value it
held throws `UNIQUE constraint failed: doc.code` against a table the client just
said was empty. Every first diagnosis went to the index.

**Ruled: the slot stays held**, so no DDL changed. The alternative was a partial
unique index (`… WHERE "deletedAt" IS NULL`), and it was rejected because it
makes `@unique` false for any read that includes deleted rows:
`findUnique({ code }, { withDeleted: true })` would legitimately match two, and
every export, audit query, migration and `release:check` reading with deleted
rows would see duplicates on a column declared unique. It also makes `restore()`
conditionally impossible, which is soft delete's entire contract — a way back
that fails because a stranger took the value is not one. `DECISIONS.md` § Query
& write semantics carries the full argument, including the cost of the rejected
option: SQLite cannot make an inline `UNIQUE` partial, so it would mean
re-emitting every constraint as an index and rebuilding every affected table —
15 of basecamp's 37 models.

So the defect was the report, and `SoftDeletedUniqueError` (409, not retryable)
replaces it: the field, the value, the holding row's id, and both ways to
release a slot deliberately — move the value with
`update({ …, withDeleted: true })`, or stop keeping the row with
`delete({ …, withDeleted: true })`. Composite `@@unique` names both columns. An
ORDINARY conflict is untouched: the re-read runs only on the failing path and
only reinterprets a conflict a DELETED row caused.

**Probing it found the worse half (FJS-278): four write paths, four answers, two
silent.**

| against a soft-deleted row holding `code: 'x'` | was |
| --- | --- |
| `create` · `createMany` | SQLite's raw message |
| `upsert` | returned `null`, wrote nothing |
| `upsertMany` | wrote the update INTO the deleted row, reported `{count: 1}` |

`upsertMany` is the one that loses data: the write lands where no read returns
it and `deletedAt` is never cleared, so it is invisible for good and the caller
was told it succeeded. Two causes — `upsert`'s race-recovery fallback assumes a
UNIQUE conflict means a LIVE row appeared between its `findFirst` and its
insert, so it retried as an `update` that filtered the deleted row and matched
nothing; `upsertMany` is `ON CONFLICT DO UPDATE`, resolved by SQLite, which has
never heard of soft delete. All four answer the same error now. The fallback
re-throws rather than swallowing it — an upsert may not resurrect a row nobody
asked it to — and `upsertMany` asks BEFORE the statement runs, because
afterwards the write has already happened. The genuine race the fallback exists
for has its own test.


## 2026-08-15 — `in`, membership in the policy language (FJS-205)

`@@allow('read', auth().id in memberIds)` did not parse — `Expected RPAREN, got
'in'`, a line and a column with no statement about what was wrong. The grammar
compared scalars, so an audience held ON the row had no expression at the Data
boundary and had to become a service where-clause, which is exactly what
`@@allow` exists to prevent: a forgotten filter is an exposure.

**The list is always the RIGHT operand.** That is what makes one operator enough
for the three shapes rather than two operators facing opposite ways:

```
@@allow('read',   auth().id in memberIds)          // the row holds the list
@@allow('delete', ownerId in auth().ownedIds)      // the principal holds it
@@allow('update', status in ['draft', 'review'])   // written literally
```

An array column compiles to `EXISTS (SELECT 1 FROM json_each("memberIds") WHERE
value = ?)` — the same SQL `where: { col: { has } }` already produced, so
membership has one definition and not two. The other two compile to `IN (?, …)`,
and the empty list is answered before any SQL is built: `IN ()` is a syntax
error, and nothing is in an empty list. The literal form also retires
`status == 'draft' || status == 'review'`.

It landed in **both** compilers. A form in one and not the other is FJS-195
repeating — `field == null` was in neither, so create allowed a row that read
then hid — and `verifyRowPolicies` is the oracle that holds them together.
**It could not see this operator when it arrived**: its seeder took values off
the predicate, so it put the principal's scalar id into an `Int[]` column, the
insert failed, and every run reported one row all on the excluded side. Not a
wrong grade, but no grade. It seeds an array column with `[value]` now, and a
scalar column against a list with a member of it plus a numeric miss — the
string sentinel is refused by an Int column and `null` by a required one, so
before this the excluded side existed only by luck.

**What the schema can decide is decided at startup**, naming the model and
quoting the expression back — a wrong policy is an empty screen with a 200, so
there is nothing to notice later. Refused: a right operand that is not an array
field, an array on the left (overlap between two lists is a different question
and is not expressible yet), both operands naming a column on the same row, and
an `@encrypted`/`@hashed` list column, which holds an encoding rather than its
members.

**The parse error names the operator and lists what is legal** — asked for by
the row regardless of which spelling won. `policyExprToString` moved from
`access.js` to `core/policy.js` on the way: the startup check quotes expressions
back at the reader, and `access.js` says of itself that production code never
imports it, so the dependency had to point the other way.


## 2026-08-15 — `db.$audit()`, for what `@@log(audit)` cannot see (FJS-276/267)

`@@log(audit)` is a side effect of a write, so it covered exactly the events that
ARE writes — and the ones an app most wants are not. A failed login performs no
write and left no trace at all. A successful one left `create:session` with
`actorId: null`, because the write goes through `asSystem()` and a system context
names no principal; measured, `$setAuth(u).asSystem()` gives null too, so there
was no way for a system-context write to carry an author into the log.

`$audit({ operation, model, records, actorId, meta })` is the one owner of
putting a row in the trail. The log model is an ordinary accessor a caller could
write directly, and that is the point: two writers with no shared definition is
how a second `operation` vocabulary starts drifting from the first.

**It throws**, where `@@log(audit)` is fire-and-forget. That difference is the
whole design: there, logging is a side effect of a write that already succeeded
and must not fail it; here, the record IS what the caller asked for, and
swallowing the failure would mean a security event silently unrecorded. A caller
on a path that must not fail catches it and says so.

`actorId` defaults to the calling client's principal and a stated one wins over
`onLog`'s — `onLog` is a generic enricher over every entry, a `$audit` caller is
naming one event. Unknown keys are refused BY NAME rather than dropped. On every
flavour of client, which `$checkWhere` shipped without and paid for.

`meta` is written as given and nothing redacts it: field redaction protects
columns the SCHEMA declared protected, and this has no schema behind it.

## 2026-08-15 — an aggregate names a column (FJS-202, FJS-273, FJS-255)

`aggregate` and `groupBy` are the two reads that never build a row: they name a
column in the SELECT and take the value straight out of SQLite. So both of the
things `read()` does for a row had to be done here by hand, and neither was.

**A name that is not a column answered a constant.** SQLite reads a
double-quoted identifier it cannot resolve as a string literal, so nothing
failed — `aggregate({ _max: { comp: true } })` returned `{ _max: { comp: 'comp' } }`
and `_sum` returned `0`. Filed as a `@computed` problem; measuring it found
`@from`, a relation and a plain **typo** doing the same, across eight arguments
that can carry a field name. `groupBy`'s `by:` refused, but only by accident,
with SQLite's own `no such column: order.label` — a message naming a table
rather than the model, and never the reason.

**A column the caller may not read answered in full.** `applyFieldPolicyTo` is
the one owner of *may this caller see this field* and it answers per row, so an
ordinary signed-in caller could ask for `_max` over a `@guarded` salary and get
it. Two of these are not aggregates at all: `_stringAgg: { field: 'salary' }`
answers every value joined with commas, and `by: ['salary']` answers every
distinct value with a count.

One guard, two tiers. `by`, `_count: { distinct }` and `interval` need a real
column and nothing more — grouping stored text is self-consistent, every
distinct value is its own group, and the key is hydrated back into the shape a
row read gives it. Everything producing a VALUE also refuses the opaque bucket
`orderBy` already had: `MAX` over a JSON array orders that text, so `['10']`
ranks below `['9']`. `fieldReadRefusal` mirrors the strip ladder over a name,
and a field-level `@allow('read', …)` is refused rather than evaluated — it is a
predicate over a row and there is no row. `asSystem()` reads what it may, and
`@hashed` is refused for everyone.

The crossing matrix promoted 8 cells. Two of them, `encrypted × aggMax` and
`encDet × aggMax`, moved from `ok` to `ref`: they had been answering the maximum
CIPHERTEXT, in the right shape, which is what made the cell read as fine.

**The three lock errors are 409s** (FJS-255). They declared `retryable` and no
`status`, so `toFrameworkError` fell through to its name branch and answered
`GeneralError` — a caller told the server had broken about a lock another
request was holding. `errors.snapshot.md` flipped all three rows on
regeneration, and junction's test now also asserts that **no** Litestone class
in that table lands on 500, since every one of them is a class this repo owns.


## 2026-08-15 — a package can ship a schema fragment (FJS-265)

An import specifier was always a path, so `import "@frontierjs/auth/schema.lite"`
looked for `db/@frontierjs/auth/schema.lite` and failed. The only way to use a
package's models was to COPY them into the app, which is what `fli auth:install`
did — and an upgrade to the package reached nothing.

**A non-relative specifier now resolves through node**, from the importing file,
so the package's own `exports` decides what is importable and nothing guesses at
a path inside one. The failure message names both causes — not installed, or not
exported — always, and deliberately: node distinguishes them with
`ERR_PACKAGE_PATH_NOT_EXPORTED` while bun collapses both into `MODULE_NOT_FOUND`,
so branching on the code would make the error depend on which runtime read the
schema and say one thing under `bun test` and another under `node`.

**`import "..." into <db>`** is the other half. A shipped fragment has to spell
some database name and only the importing app knows what its own are called, so
`into` is the one parameter that varies — it is what `fli auth:install --db auth`
now emits instead of rewriting a copied file.

One rule, stated twice: the NEAREST statement about a model's database wins. An
inner `into` on a nested import beats an outer one; any `into` beats a `@@db` in
the imported file; a model naming no database gets one. Importing one file twice
under two different `into`s is an ERROR rather than a precedence puzzle — it is
merged once, so only one could ever hold.

`inlineImports` follows a package specifier too, and applies `into` on the text
with the same nearest-wins rule, so `release`'s baseline and `createTestEnv` see
what `parseFile` sees. The two paths are compared against each other rather than
described as equivalent.

## 2026-08-15 — every CLI command ignored `import` in a schema (FJS-264)

`createClient` has always resolved `import "./other.lite"` — it goes through
`parseFile`. `loadSchema()` in the CLI read the root file and called `parse()`,
so all twenty commands behind it saw the root file alone.

Nothing said so, because the comparison was internally consistent: `db push`
diffed the database against a schema with the imported models missing and
reported **already in sync** while their tables were never created. The same
blindness reached `ddl`, `jsonschema`, `access`, `types`, `migrate` and
`release` — every committed snapshot describing a split schema described half
of it.

`loadSchema` and studio's live reparse use `parseFile`. `parse` is now for text
with no file behind it — an editor buffer, a git blob — where the caller owes
the imports.

**`release`'s baseline is that caller, and it inlines them AT THE REF.** The
previous release's files live at a git ref, where there is no tree to walk;
reading them from the working tree instead would compare the previous release's
root schema against today's imported models and call every one of them
unchanged, which is the exact blindness being removed. An import that cannot be
read there is a named note on the baseline, not silence.

`test/cli-smoke.test.ts` § *a schema that imports another file* — push, ddl and
the release baseline, each checked against a negative control.

**Two more readers had it, and one of them inverts a guarantee.** Sierra's build
handed the browser a `$defs` table with the imported models missing, so
`modelNameFor` missed, `createResource` fell back to a bare `make()`, and a
generated `<Form>` rendered nothing against an app that built clean. And
`createTestEnv({ schema: 'path' })` read the root file and parsed the text, so
every executed check — `verifyGateLadder`, `verifyRowPolicies`,
`verifyFieldProtection`, `verifyConstraints` — graded a schema with the imported
models missing and **passed**. A green ladder over models it never saw is worse
than no ladder, and it is the thing that exists to catch the other two.

`createTestEnv` splices the imports into ONE text rather than deferring to
`parseFile`, because that text is the template cache key: keyed on the root file
alone, editing an imported file reuses the previous run's database. An import it
cannot read is **refused**, not warned — those models would silently go ungraded.

`inlineImports` / `inlineImportsFromDisk` are exported from `parser.js` as the one
owner of following an import line as text; `release`'s baseline and
`createTestEnv` are the two callers, and reading stays theirs because a git ref
takes posix paths and a file on disk does not.

**`parseFile` also answers a bad schema the way `parse` does now.** It let a
`ParseError` throw where `parse` returned `{ valid: false, errors }`, so every
caller that warns and keeps going got a stack trace instead — which is how this
surfaced: sierra's *warns and returns null on an unparseable schema* went red the
moment the plugin started using it. An error inside an imported file names that
file.

## 2026-08-15 — the plural rules are `@frontierjs/toolbelt/inflect` (FJS-192)

`pluralizeWord` in `ddl.js` and `toSingular` in `introspect.js` were two of five
copies of English's inflection rules in this repo, and the five did not agree.
Both now call one module. Litestone still owns the naming DECISION — snake_case,
`@@map` wins, pluralise only when asked — and no longer owns the rules.

**Seven irregulars became reachable, and that renames a table.** The table was
consulted last, behind the sibilant rule, so `index` was taken by `x$` and came
back `indexes` while the table said `indices`; the same for `matrix`, `vertex`,
`analysis`, `basis`, `crisis` and `ox`. A schema with a model of one of those
names and an existing table keeps it with `@@map` — no schema in this repo has
one, checked before the change.

The irregular table matches a WHOLE word only, so a compound is unaffected:
`audit_index` is still `audit_indexes`. Reaching inside a compound would rename
tables in schemas that already exist, which is a migration, not a fix.

## 2026-08-15 — a write takes the same flags a read takes (FJS-176, FJS-263)

`@@hasTemplates` had its intent recorded in one place — a comment in the parser
— and it covers reads only: *default reads exclude templates, opt in per call
with `withTemplates` / `onlyTemplates`*. Everything wrong with it was on the
side that sentence does not describe.

**Templates were create-once and uneditable.** `update`, `updateMany`, `upsert`
and `remove` hardcoded `instances` with no argument that opted in, so every
route answered *no such row* — `null`, `{ count: 0 }` — and **`asSystem()` did
not help**, because the template filter is not an access rule. Meanwhile
`delete` and `deleteMany` applied no filter at all and destroyed a template
happily. A row class that could not be corrected but could be lost, and a
promotion trapdoor beside it: `update({ isTemplate: true })` always worked and
nothing could ever reach the row again to demote it.

Ruled: **a template is a live parallel class, not an end state**, so the writes
take the flags. That is the difference from `@@softDelete`, which the flags
otherwise mirror exactly — a deleted row is out of play and `restore()` is its
documented way back, which is what makes "you cannot edit a deleted row"
coherent there. A template is the thing every instance was cloned from, and
maintaining it is the point.

```js
await db.quote.update({ where: { id }, data, withTemplates: true })
await db.quote.updateMany({ where: {}, data, onlyTemplates: true })
await db.quote.update({ where: { id }, data: { isTemplate: false }, withTemplates: true })  // demote
```

**One behaviour change, in the safe direction.** A hard `delete`/`deleteMany`
now applies the template filter, so an ordinary cleanup stops destroying rows
that no read of the model returns. It still bypasses the *soft-delete* filter,
which is its stated contract and the reason it exists beside `remove` — and a
flag now narrows that too, so `deleteMany({ where, onlyDeleted: true })` is how
a purge is spelled rather than raw SQL.

**`withDeleted` on a write was accepted and silently dropped** — not in the
destructured signature, so it went the way an unknown key goes, while `take` and
`skip` on the same call throw by name. It works now.

**`aggregate` and `groupBy` ignored both families' flags** (`FJS-263`), pinned
to `live`/`instances` regardless of their args. So
`aggregate({ _count: true, onlyDeleted: true })` answered the count of the LIVE
rows and `onlyTemplates` counted the instances: the opposite of the question
asked, from the two methods whose whole output is a number nothing can
cross-check against a list. Found by asking the same question of both families
at once, which is also why it is one fix rather than a template bug.

`@@hasTemplates` is documented now — `docs/schema.md` § Templates. It appeared
in no file under `docs/`, which is why there was no intent to check any of this
against.

## 2026-08-15 — `@system`, the column an application writes and its caller does not

Nothing in a schema could say *the system writes this*. So a form generated from
the schema offered a person a text box for a tracking code a courier job would
overwrite a second later, and a model whose REQUIRED columns are server-side
could not be created from a browser at all — validation refused before the
request, naming fields the caller was never meant to send, which renders as
*the button does nothing* (`FJS-095`, ruled as `FJS-D22`).

`@system` is the orthogonal sibling of `@guarded`:

|            | read        | write       |
| ---------- | ----------- | ----------- |
| `@guarded` | system only | system only |
| `@system`  | anyone      | system only |

**The write is refused by name, not dropped.** The client is told `readOnly` and
a generated form does not offer the column, so a payload naming it is code that
meant to write it — and a silent drop is the shape being fixed. A field
`@allow('write', …)` still drops, and must: there the same payload is legitimate
for another caller, which is why basecamp's three `auth().isSystemAdmin` columns
keep round-tripping unchanged through an ordinary member's profile save.

**The fill path is a per-call hatch, not `asSystem()`:**

```js
db.order.update({ where: { id }, data: { trackingCode }, system: ['trackingCode'] })
```

One column is unlocked; the gate, the row policies, soft-delete and the audit
actor all still apply. `asSystem()` writes the same value by dropping every one
of them. Naming the field IS the statement — an escape hatch may not disable a
guarantee silently. It threads through create, createMany, update, updateMany,
upsert and upsertMany.

**A `@system` column is never in create-mode `required`.** It is still NOT NULL
in SQLite, so an application that forgets to fill one fails at the write with a
message that says which side is missing — *"tokenHint is @system and was not
supplied — the application fills it, with `system: ['tokenHint']` on the call"* —
rather than the browser refusing a create it was never responsible for.

Also: `@guarded(all) @system` is now spellable, which is the combination
`FJS-235` recorded as impossible — a column invisible to a client AND unwritable
by one. `@allow('write', …)` beside `@system` is refused by name, as is `@system`
on a `@computed`/`@generated`/`@from` field, which has no write to lock.

18 tests. Nothing above litestone refuses it earlier and nothing should:
Junction's `autoValidate` does not read `readOnly`, and must not start —
`@version` is readOnly in the update schema and a patch is required to carry it
back. So this is the boundary that answers, and it answers 403.

## 2026-08-15 — a read that builds its own SQL now asks what every other read asks (FJS-262)

Found while closing FJS-215, by asking a question that had not been asked
straight: *which methods evaluate the global filter?* Two did not, and what came
out of checking the rest is worse than the filter.

**`findManyCursor` and `search()` applied neither the global filter nor the row
policy.** On a model declaring `@@allow('read', ownerId == auth().id)` and a
tenant filter, `findMany` answered one row and both of those answered all three
— another owner's row and another tenant's. Both build their own SQL rather than
going through `buildSQL`, which is the fourth time that shape has been found
missing something every other read has (`FJS-173`, `FJS-178`, `FJS-185`,
`FJS-216`).

**`aggregate`, `groupBy` and `search` never called `plugins.beforeRead`**, which
is where a `@@gate` refuses. A model at `@@gate("7")` answered a level-4
caller's COUNT, its GROUP BY and its full-text search. The row policy compiles
into the WHERE and did apply to the first two, which is exactly what hid this:
the numbers looked scoped, and the gate — the layer that refuses outright — had
never been asked.

Composed in the same ORDER `buildSQL` uses: filters, soft-delete,
`@@hasTemplates`, the caller's where, then the policy appended last as raw SQL
with its params after the cursor's. Positional binds, so the order IS the
correctness. `search` merges once and both of its steps read the same value, so
the FTS pre-filter and the row fetch cannot drift apart — and the policy is
applied at both, because the pre-filter is an optimisation and the second query
is what returns the rows.

**The grid is the fix, not the two methods.** A new test seeds one model where
exactly one of three rows is visible and asks every read method — `findMany`,
`findFirst`, `findUnique`, `count`, `exists`, `findManyAndCount`,
`findManyCursor`, `search`, `query`, `aggregate`, `groupBy` — then asks all of
them again against a gate. A method added without the composition now fails
rather than being discovered by the next audit.

## 2026-08-15 — a global filter is judged in both its forms (FJS-215)

A static filter has been refused at `createClient` since 2026-08-12 when it
names something SQLite cannot filter by. The FUNCTION form takes a `ctx` and has
no answer until a query asks it, so it was judged nowhere — the whole defect
survived behind one spelling. `resolveGlobalFilter()` is now the single place a
global filter becomes a value, six evaluation sites funnelled into it, and it
applies the same rule at the first moment there is something to apply it to.

**The unknown key was the other half of it.** Excluded from the refusal in both
forms, and it is the same failure: SQLite reads an identifier it cannot bind as
a string LITERAL, so `{ nope: 'x' }` becomes `'nope' = 'x'` and empties the
model, while `{ nope: 'nope' }` becomes `'nope' = 'nope'` and hands back **every
row** past a filter that was supposed to narrow. Both forms refuse it now, with
edge namespaces folded into the legal keys the way `withArgValidation` already
folds them for a caller's `where`.

An unknown key in a CALLER's `where` still warns. That trade was ruled and the
reasoning does not carry across: a caller has a hint and a stack, and a global
filter is app configuration applied to every read of the model for the life of
the process, with nobody to warn. Tier 3 (`FJS-202`) is untouched.

## 2026-08-15 — `now()`, and the six clock spellings that are refused (FJS-226)

`DateTime` is stored as ISO-8601 TEXT — `2026-08-13T07:38:31.984Z` — and every
comparison against it is string-wise. SQLite answers `datetime('now')` as
`2026-08-13 07:38:31`: space separator, no milliseconds, no zone. `'T'` (0x54)
sorts above a space (0x20), so **every row stored today compares greater than a
same-day `datetime('now')`**. Measured on four tasks:
`where: { $raw: sql\`dueAt < datetime('now')\` }` returned the one overdue by a
day and silently omitted the ones overdue by an hour and a minute.

What makes it worth a refusal rather than a note is that it is *nearly* right,
and wrong in the direction nobody checks. It is the first spelling SQLite's own
documentation shows; a demo seeded with last week's data passes; the failure
only appears for rows inside today, on the query that matters most.

**`now()`** is the spelling that matches — exported beside `sql`:

```js
import { sql, now } from '@frontierjs/litestone'

db.task.findMany({ where: { $raw: sql`dueAt < ${now()} AND completedAt IS NULL` } })
db.task.findMany({ where: { $raw: sql`startedAt > ${now('-7 days')}` } })
```

It emits `strftime('%Y-%m-%dT%H:%M:%fZ','now')` rather than a JS timestamp, so
every occurrence in one statement is the same instant — SQLite fixes `'now'` for
the duration of a statement, which two `new Date()` calls cannot promise. The
consequence, stated in the docs: `createClient({ now })` does not reach it. That
clock belongs to the policy evaluator; a test needing a frozen instant in a raw
predicate binds its own ISO string.

Modifiers are **bound**, not spliced: `strftime` takes them as parameters, so a
caller-supplied `'-7 days'` never enters the SQL pattern and Invariant 8 holds
inside the escape hatch. That is what a fragment is — litestone's own SQL, the
only thing the `sql` tag splices instead of parameterising, and nothing built
from caller text can be one.

`now()` also works written as a **token** in raw SQL — `where: "dueAt < now()"`
in a `@from`, or a plain-string `$raw` — because those two callers cannot
interpolate, and a refusal naming a spelling the caller cannot write is a
refusal that does not help.

**Six spellings are refused by name**: `datetime('now')`, `date('now')`,
`time('now')`, `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME` — each
produces a format no stored `DateTime` can equal, so a comparison against one is
not a filter returning too few rows, it is a filter answering a different
question. Checked at all three doors raw SQL comes through: the `sql` tag, a
plain-string `$raw` (which skips the tag, and is the form written when there is
nothing to interpolate — exactly the shape of the bug), and a `@from(where: …)`
string, which is refused at `createClient` because the subquery is built once at
startup and that is the last moment anything reads it.

**`julianday()` and `unixepoch()` are untouched.** They answer numbers, so
`julianday('now') - julianday(createdAt) > 30` compares like with like — the
date-arithmetic example in `docs/filtering.md` was always correct. `strftime` is
untouched too: its format string is the caller's to get right, and getting it
right is what `now()` is.

Also fixed while here: the `_litestone_seeds` ledger stamped `appliedAt` with
`datetime('now')` while `_litestone_migrations` stamps `new Date().toISOString()`
— two ledgers answering *when did this run* in two formats, which sort against
each other wrongly the moment anything reads both. Now ISO on both.

`docs/gotchas.md` taught the broken spelling in two worked examples; it and
`docs/filtering.md`, `docs/access-control.md` and both `CLAUDE.md`s now teach
`now()`.

## 2026-08-15 — the array rules join every other rule (FJS-194)

`@minItems`, `@maxItems`, `@uniqueItems` and the `Int[]`/`String[]` element
checks were enforced inline in `client.js`'s `writeData`, with their wording
built at the throw site — the one family that did not go through `validate.js`.
Two things followed. An authored `@minItems(2, "Pick at least two tags")` parsed,
stored, and reached the browser through `x-messages`, where Sierra refused the
write saying *Pick at least two tags* — while the server refused the same write
with *tags must have at least 2 item(s)*. So a caller who bypassed the form saw
wording nobody wrote, and *one authored string, all three realms* was false for
this family alone. And with no entry in `DEFAULT_MESSAGES` there was no default
for `x-messages` to fall back to either.

The five rules are now `VALIDATORS` + `DEFAULT_MESSAGES` + a `validateField`
case like every other rule, and `writeData` calls `validate()` and nothing else.
Consequences beyond the message:

- **`@uniqueItems` takes a message now.** It was the only validator that did not,
  which made *every validator takes an optional trailing message* untrue in the
  documentation. `parseOptMessage` already existed for `@email` and friends.
- **The default wording lost its field-name prefix** — `must have at least 2
  item(s)`, not `tags must have at least 2 item(s)` — because that is the shape
  every other rule in the table has and the path already carries the field.
- **All the array errors come back at once.** The inline block threw on the first
  one; a `ValidationError` from `validate()` carries every failure.
- **`buildValidationMap` flags a model with any array field.** The inline checks
  ran unconditionally, and `validate()` does not — a model whose only rule was a
  bare `String[]` would have silently stopped being checked.
- **`generateValidationCases` reads the table** instead of restating the wording.
  That second copy is what noticed this: the generator had to hand-write what the
  server said, and writing it down is what showed it did not match the client.
- `uniqueItems` joined the `x-messages` keyword table in `jsonschema.js`, so an
  authored message is keyed by the JSON Schema keyword as well as the rule name.

## 2026-08-15 — `litestone release`, the pivot classifier

A deploy replaces code and does not replace the rows already written, so the
question it has to answer is not *is this migration reversible* but **can
Release N-1 and Release N serve one database at once**. Every deployment system
surveyed ships a rollback that restores code and nothing else, and the reason is
that none of them can see the shape of the change. We can: the schema is a file
we parse.

`src/release.js` derives the **release surface** — every model with its table,
gate, fields, defaults, constraints, row policies and state transitions — and
`classifyPivot(before, after)` answers **expand** (N-1 keeps serving, so the
deploy can be taken back), **contract** (it cannot, so that deploy is the pivot)
or **unknown**, which counts as a contract because a wrong *reversible* is the
only answer that costs anything.

Two halves of it are things no generic deployer can reach. **Access is a
compatibility change**: raising a `@@gate` takes reads away from a release still
serving them, and adding an `@@allow` empties a screen with a 200 and no error.
And a **required column with no default** is the one contract with a supported
alternative, so it is not merely refused — the three steps come back with it:
declare it optional and deploy, backfill, declare it required and deploy again.

`litestone release` writes `release.snapshot.md` beside the schema and classifies
against `HEAD`; `--from v1.4.0` asks the question a deploy asks. `--check` is
staleness alone, which is what the snapshots CI phase reruns out of the file's
own header — a check that also needed git would fail in a tarball rather than in
a repository. `--strict` exits 1 on anything but expand, **including no baseline
at all**: it asks for a reversible deploy and *I could not tell* is not one.

The snapshot holds the surface and **never the verdict**. A verdict is a fact
about two schemas and the file describes one, so writing it in would make the
file depend on its own previous contents — and a file that cannot be regenerated
twice to the same bytes cannot be rechecked, which is the whole mechanism.

Falling out of it: `columnDefaultExpr()` is now exported from `core/ddl.js` and
is the one owner of *does an INSERT that omits this column succeed*. The DDL
emitter and the classifier ask the same field the same question, and a second
copy of that rule would have drifted. 31 tests; the DDL snapshots of both apps
in the repo are byte-identical across the refactor.

## 2026-08-15 — `@from(first/last)` picks under the caller's policy (FJS-224)

The subquery that resolves the id is built once when the client is created, and
a `@@allow` binds `ctx.auth` per request — so the row it picked was the newest
one that EXISTS, and the policy was applied afterwards, when the row was
fetched. An account whose newest order belongs to someone else therefore read
`lastOrder: null` even when it had older orders the caller could see: *no last
order*, where the truth was *your last order is the one below it*. A plausible
wrong answer, which is the worst kind.

The pick is now redone in `resolveFromRowRefs` whenever the target declares a
read policy: the policy goes into the WHERE and `ROW_NUMBER() OVER (PARTITION BY
<fk>)` chooses one row per parent, which is the answer a direct `findFirst`
would have given. The window runs INSIDE the policy rather than over it —
ranking first and filtering after would rank rows the caller cannot see and then
delete the winner, which is the same null wearing a second hat. Still one query
per field across every row in hand.

With no policy nothing changed: the id from SQL is already right and the cheaper
fetch-by-id runs. `@@softDelete`, `@@hasTemplates` and a declared `where:` on the
`@from` all survive the repick — they are lifted out of the static subquery and
restated with the table in place of its alias, because a policy compiling
`check(parent)` names the table and an alias puts it out of scope.

The repick correlates on the column the target points back at, so
`parseSelectArg` now injects that column the way it injects an FK for a
relation: `select: { lastOrder: true }` alone still repicks, and the key does not
appear in the answer. That path is where the residue would have lived — it
fell back to the pre-policy id and nothing said so.

## 2026-08-15 — `@guarded` locks the write too (FJS-235, FJS-248)

`@guarded` stripped its column from every read and did **nothing at all** on the
way in. A `$setAuth(user)` client could create a row carrying `riskFlag: 'HIGH'`
and patch it to `'TAMPER'`; both landed, and every read back through that same
client showed the field absent. Invisible and writable at once is the
mass-assignment shape — the caller cannot see what they are overwriting, the
owner cannot see that they did — and the read strip is what kept it quiet, since
a landed write and a refused one look identical when the answer has no column.
Junction covered the HTTP door by accident (`generateJsonSchema` omits guarded
columns for the client audience, so `autoValidate` rejects the key), which left
a Caravan job, a seeder and any service writing through `ctx.locals.db` writing
it unimpeded — the API realm enforcing what the Data boundary is supposed to own.

`writeData` now refuses a non-system write that names a guarded column, with an
`AccessDeniedError` naming every field. One owner, so `create`, `update`,
`updateMany`, `upsert`, `createMany` and `upsertMany` are all covered.

**Refused rather than dropped**, which is the opposite of what a field
`@allow('write', …)` does beside it. That predicate is per-caller — the same
form body is legitimate one level up — so dropping the key is the right answer
there. Nothing may write a guarded column, so naming one is a mistake and saying
so beats silence. `@allow` still cannot sit beside `@guarded`, and that stays
the design: two answers to one question, pick the one that describes the column.

**`@encrypted` alone is deliberately outside this.** It used to imply
`guarded: 'all'` in the field policy map, which would have made every encrypted
column system-write-only and broken the ordinary case — an admin adding a secret
through a scoped client. The read strip already had its own branch for
`encrypted`, so decoupling them changed no read behaviour; `@secret` synthesises
a real `@guarded(all)` and is locked both ways as before. Audit redaction asks
for `encrypted || guarded` and is unaffected (Invariant 7).

Two consequences worth knowing. A **required** guarded column now makes its
model uncreatable below level 8 — the FJS-095 shape, one layer down — and
`verifyGateLadder` reports that create column ungraded rather than reading the
field lock as a gate verdict, the same treatment a row policy already got. And a
seed or script that wrote a guarded column through the default client now needs
`asSystem()`, which is what every caller in this repo already did.

## 2026-08-14 — `verifyFieldProtection` could not build a row on a policied model

`verifyRowPolicies` learned last week that **the field a policy compares is very
often a FOREIGN KEY** — `workspaceId == auth().workspaceId` is the whole of a
multi-tenant app — so it calls `_ensureParent()` before seeding a row with the
value taken off the predicate. `verifyFieldProtection` seeds the same way and did
not, so the moment a model with a protected field also declared an `@@allow`, the
child was refused by the constraint and the whole model reported as

```
Secret — no row could be built, so none of its 1 protected field(s) were
checked: FOREIGN KEY constraint failed
```

Which is the right kind of failure — it says out loud that nothing was checked
rather than passing on an empty set — but it made the check unusable on exactly
the models that most want it. One call, the same one, in both places.

Found by declaring row-level tenancy on basecamp's `Secret`: 15 models could
carry the policy and only one of them has a `@guarded` column, so nothing before
it had put the two attributes on one model.

## 2026-08-14 — `litestone jsonschema --snapshot` — the client contract, diffable

`generateJsonSchema` is the widest bridge in the repo: Junction validates
requests against it, Sierra's `field-rules.js` re-checks the same rules in the
browser, and `<Form>` renders a control from it. Three readers, one document,
and **nothing breaks when a keyword stops being emitted** — a form just stops
validating.

`--snapshot` writes `jsonschema.snapshot.md` beside the schema: the `$defs`
table (a name that disappears is a `$ref` resolving to nothing in a browser),
every enum's values, and per model the gate, `x-version`, each relation, each
`@@transitions` move with its own gate, then one row per field — type and
default, required, `@label`, the keywords a validator branches on, and which
rule names `x-messages` answers for. Each model closes with what CREATE mode
accepts, which is the shape `FJS-095` lives in: a required column only the
server can fill is refused before the request is ever made.

A second RENDERING, not a second generator — the raw JSON is what ships, and
thousands of lines of it is where a removed keyword hides. `--check` byte-
compares, through the same `checkSnapshot()` as `access` and `ddl`.

Two emitted shapes the first draft got wrong and now reads: a nullable
`DateTime` arrives as an `anyOf` with the format on the branch, and a `Json`
column carries no `type` at all.

## 2026-08-14 — a string operator on a column that is not text

`FJS-210`. `{ tags: { contains: 'x' } }` on a `String[]` compiled to `LIKE '%x%'`
over the stored `["x","y"]`, so it matched — and matched `["xylophone"]` too,
while `contains: '","'` matched every array of two or more elements and
`contains: '['` matched all of them. It looked like `has` and was a substring
search over a serialisation; the cases where the two agree are exactly the ones
that hid it. On a `Boolean` the same operator answered `[]`, silently, because
the value is stored as 0/1.

Refused now, naming the operator that was meant — array (`has`), `Json`
(`@type(...)` and a path), `File`, `Boolean`. **`Int` and `DateTime` keep the
answers they already gave**: SQLite's coercion answers what was asked, and
`{ when: { contains: '2024-01' } }` against an ISO column is a real way to ask
for a month. A path INTO a typed `Json` column is untouched — that operand is
text.

**One map, not one per question.** `buildWhere` already took an `arrayFields`
set for a different reason (a bare array means `IN` on a scalar and `hasSome` on
an array column — the operand cannot say which). That set is now a
`fieldKinds` Map of what the column HOLDS, which is the same fact both questions
need, so the builder's signature did not grow and `buildArrayMap` is gone rather
than sitting beside a second map of the same thing.

**Both `where`-clause refusals are `ValidationError`s now**, the array-operator
guard included. Junction maps the name to a 400; they were bare `Error`s, which
is a 500, and a 500 says the server broke when the caller asked for something
the column cannot answer.

The six `210:ref` cells in `test/matrix.test.ts` are promoted to `ref`.

## 2026-08-14 — a key rotation carries every reversible column, or refuses

`FJS-253`, found while pinning `FJS-236` and the larger half of it. `$rotateKey`
re-encrypted `@secret(rotate: true)` fields and then swapped the client's key for
**all** encryption. Measured across five column kinds, four broke:

```
@secret                  rotated     reads "T"
@secret(rotate: false)   untouched   reads null
@encrypted               untouched   reads null
@encrypted(det: true)    untouched   reads null, filters 0 rows
@hashed                  untouched   matches 1 -> 0, permanently
```

Not a stale-key artefact — the bytes on disk were never rewritten, so a brand-new
client with the new key could not read them either.

Rotation now carries every key-reversible column, and **refuses before the first
write** when the schema declares one it cannot. A rotation that rewrites half a
database and then complains leaves it in two keys with nothing recording which
rows are in which.

```js
await db.$rotateKey(newKey)
// Error: $rotateKey would leave 2 column(s) unreadable and has rotated nothing:
//   User.pw     — @hashed — one-way, there is no plaintext to re-key …
//   User.legacy — @secret(rotate: false) — declared excluded from re-encryption
// Pass { orphan: ['User.pw', 'User.legacy'] } to accept that deliberately.
```

`orphan` is a **list of names, not a boolean**: a column added later must not
inherit an acknowledgement made for a different one. `classifyForRotation()` is
the one answer to *can rotation carry this column*, asked by the refusal and by
the loop, so the two cannot disagree about which columns exist.

**`@secret(rotate: false)` keeps its name and loses its promise.** The docs said
it stays *bound to the original encryption key*; one client holds one key and
nothing retains the old one, so it never did. It is now documented as what it is —
excluded from re-encryption, and unreadable after a rotation.

A deterministic column stays FILTERABLE across a rotation, not merely readable:
the where-encoder encodes its operand with the key before comparing, so a column
re-encrypted in the wrong mode answers 0 rows with a 200 and no warning.

## 2026-08-14 — the encryption key is a cell, not a copy

`FJS-236`. `$rotateKey` ended with `ctx.encKey = newKey` on the root context, and
every derived client is a spread of it. A spread copies a string by value, so the
rotation reached the root and no client already handed out — and `read()`'s catch
turned the resulting GCM failure into `null`, so the field read as **empty**
rather than as broken.

```
ctx.enc = { key }        one object, shared by reference through every spread
```

Read at all ten sites (`client.js` x8, `policy.js` x2). One assignment now
reaches `asSystem()` — memoised in `_systemProxy`, so it stayed wrong forever —
`$setAuth()` and `$scopedBy()` alike, and a context added later inherits it
without anyone remembering to propagate.

`$setAuth` is not memoised, which is why a client made AFTER a rotation always
worked and one made BEFORE did not. That is the difference that made this look
intermittent.

**The suite passed over it** because the only assertion was that the ciphertext
had CHANGED — which a rotation that scrambled every row beyond recovery also
satisfies. It reads the value back now, and three tests pin the derived clients;
two were confirmed to fail against a simulated copy-by-value before being kept.

**`FJS-253` is underneath this and is the larger half**: `$rotateKey` rotates
`@secret` fields and swaps the key for *all* encryption, so a plain `@encrypted`
column keeps ciphertext written under the old key and becomes unreadable and
unfilterable. Pinned as asserted-still-broken.

## 2026-08-14 — a column whose stored text is a storage detail is not a sort key

`FJS-200`. `orderBy: { words: 'asc' }` on a `String[]` reached SQLite as an
`ORDER BY` over the stored document, so rows came back ordered by the string
`["x","y"]` — `[10]` before `[9]`, and a re-serialised row moving for no reason.
`$checkOrderBy` answered `[]`, *no problems*, so Junction's `autoSort` passed it
through and no boundary refused it either.

`sortableKeysFor()` split a model's keys three ways — sortable, relations,
computed — and an array column fell into `sortable` by default. It now has a
fourth bucket, `reason: 'opaque'`:

| Kind | Ordering by its text means |
| --- | --- |
| `String[]` · `Int[]` · `Enum[]` | the JSON document |
| `Json`, typed or not | whichever key serialised first |
| `File` | the storage reference |
| `@encrypted` | ciphertext — stable only where the IV is derived from the value |
| `@hashed` | the digest |

**`File` was added on the row's own principle** rather than named by it: the
stored value is a reference document, which is the same failure wearing a
different type. Sorting *within* an array stays undefined, deliberately — the
question was only whether the column may be a sort key at all.

This is the rule `docs/sorting.md` already stated for `@computed` and never
applied here: a bad sort key returns the right rows in the wrong order, which
nothing can see, so it throws rather than warning.

Junction reads the new `reason` and says its own sentence, so a 400 still
separates *no such field* from *not a sort key* — `$checkOrderBy` is a bridge and
both sides moved together.

**One regression, caught by the existing suite.** An implicit many-to-many
(`tags Tag[]`) is an array in the AST and a join table in SQLite, so the array
bucket took it and `orderBy: { tags: { _count: 'asc' } }` stopped compiling. It
is claimed as a relation first now, where `buildRelationOrderBy` owns the
grammar.

The eight `200:ref` cells in `test/matrix.test.ts` are promoted to `ref`.

## 2026-08-14 — `litestone types` emitted a client no app could use

Found by wiring it into basecamp, which is the first app to use it. Four
defects, each one enough to send an app back to `any`:

- **`TableClient` was missing six methods a real accessor has** —
  `findManyAndCount`, `exists`, `aggregate`, `groupBy`, `query`, `transitions`.
  basecamp calls `exists` 16 times and `findManyAndCount` 12, so the generated
  file typed 28 correct calls as errors. A .d.ts that is missing a method is
  worse than no types: the app either casts the client back to `any` — losing
  everything the file was for — or stops regenerating it.
- **`LitestoneClient` was missing six members** — `$scopedBy`, `$checkWhere`,
  `$checkOrderBy`, `$rotateKey`, `$rawDbs`, `$walStatus`. The two `$check*` are
  the seam Junction's `autoFilter`/`autoSort` are built on.
- **`CreateClientOptions` declared `onEvent` twice** — a TS2300 that makes the
  whole file unusable — and named `encryption: { key }`, which `createClient`
  does not destructure. The real option is `encryptionKey`, and the wrong shape
  is an app that boots with no key and fails on its first `@secret`.
- **A nullable column was typed `T` on write, so clearing one did not
  typecheck.** An explicit `null` CLEARS and absent leaves the column alone
  (Invariant 9) — the one way to clear a field was a type error. Create and
  Update now emit `field?: T | null` for a nullable column, and a required
  column stays required.

Three tests hold it: two ask a LIVE client what it has and require the emitted
interface to declare each name — a method added to the client and not to the
generator now fails — and one pins the options shape, including that no key is
emitted twice.



## 2026-08-14 — `litestone ddl`, and a snapshot that names its own generator

The access snapshot's sibling. `litestone ddl` writes `ddl.snapshot.sql` beside
the schema — every `CREATE TABLE`, index, FTS table, `updatedAt` trigger, join
table and view, one section per declared database, with `jsonl`/`logger` named
and skipped. `--check` byte-compares the committed file the way `access` does;
both now go through one `checkSnapshot()` rather than two copies of the diff.

Access covers a rule nothing below the API can show you. This covers the
opposite: a name everything above it binds to. Columns are emitted verbatim
camelCase and `DateTime` as ISO-8601 TEXT, and an app's own tests go through the
client that changed with the emitter, so a renamed column is invisible in the
app it breaks.

**Both snapshots now carry a machine-readable header** — `<!-- generated by:
litestone access --schema schema.lite -->`, `-- generated by: litestone ddl
--schema schema.lite`. `scripts/ci.mjs`'s `access` phase was one hardcoded
command; it is now `snapshots`, which walks every committed `*.snapshot.*`,
reruns the command in its header with `--check` from the file's own directory,
and refuses a command that is not a known binary with a shell-free argv. A new
kind of snapshot costs a generator, not a CI edit.


## 2026-08-14 — Studio shows the access surface, and says when it has drifted

`deriveAccess()` already returned the whole access surface as an object and had
exactly one reader — the committed `access.snapshot.md`. That file is good at
being **reviewed** (the `access` CI phase byte-compares it, so a widened gate
arrives as a diff) and bad at being **read**: 37 rows of `"4.4.4.5"` answers
*what does this model require* and never *what can a level-4 caller do*.

**`GET /api/access`** is `deriveAccess()` and nothing else. **Access** panel,
four views over that one payload: the gate matrix as a grid, policies shown
beside the gate they compose with, protected fields, and **By level** — pick a
standing 0–8 and see the whole schema from it, computed with the same
`expectedVerdict()` the gate ladder is graded against.

**`GET /api/drift`** and a header badge, answering three questions kept apart
because one "out of date" would blur them: has the schema **file** changed since
Studio parsed it, is the committed **snapshot** still true, are there **pending**
migrations. The first matters most and was invisible: Studio parses once at boot,
so a schema edited in an editor left every panel describing the previous version
with full confidence. Both the badge and the access panel now read through
`currentSchemaParse()`, which re-parses only when the bytes differ and keeps the
last good parse through a half-typed edit.

**No "regenerate snapshot" button, deliberately.** The committed file is a review
artefact; one click that rewrites it to match whatever the schema now says turns
that review into a formality. The badge hands back the command instead.

Found while building it: **Studio never opened the panel its URL named.**
`showTool` was bound to `hashchange` only, so a fresh load of `#query` showed
Browse while the hash sat there disagreeing — against the file's own note that
*"a Studio link can name the panel it opens"*.

`bun run verify:studio` drives all of it in a real Chrome against a real server —
21 assertions, starts and stops its own studio.


## 2026-08-14 — `studio --port=0` binds a free port and says which one

`FJS-213`. `cmdStudio` printed the port it was ASKED for, so `--port=0` announced
`http://localhost:0` — a URL nothing can reach, describing a server that is up.
It prints `server.port` now.

That makes 0 the right thing for a test to ask for, which is what the defect was
about: `cli-smoke`'s studio test picked `5100 + Math.random() * 800` from a range
nothing reserves, and lost the draw twice in four `bun run ci` runs while passing
3/3 alone. A fixed number would only move the collision.

## 2026-08-14 — a migration file the name pattern rejects is named, not skipped

`FJS-193`. `listMigrationFiles` matches only litestone's own
`<14-digit>_<lower_snake_label>` name, and `apply()` read the empty list it
returns as *there are none* rather than *none of these matched*. A directory
holding one real, hand-named migration therefore reported `✓ no migration files
found` and exited 0 — a fresh deploy starting against an empty database and
saying so in the affirmative.

The pattern is not loosened: the ordering guarantee comes from the timestamp.
What changed is that the rejects are now visible.

```
unmatchedMigrationFiles(dir)   every .sql/.js MIGRATION_FILE turned down
describeSkipped(files)         one sentence, so apply/status/verify agree
```

`apply()` carries `skipped` on every return and sets `unmatched: true` when the
directory held candidates and none matched — a **refusal**, which the CLI prints
as `✗` and exits 1 on. The two used to share one tick and one exit code. A
misnamed file beside three valid ones is reported too, because silence one file
at a time is the same omission. `status()` gives it a `skipped` row; `verify()`'s
drift branch names it, since a skipped migration is the likeliest explanation for
a drift nothing else accounts for.

**`createTestEnv` reads the directory more loosely on purpose, and now says so.**
It replays a hand-named `001_initial.sql` because a person meant it; it warns once
per file that `migrate apply` will not. The two readers disagreeing was the state
this defect lived in — a suite green against a database no deploy could build.


## 2026-08-14 — `db/` is a default location for the schema and the config

`litestone access` run from `packages/basecamp` reported *No schema found* about a
schema that was plainly there. An FJS app keeps the Data realm in `db/` (root
`README.md` § Project Structure), so an app root is the obvious place to run these
from — and resolution looked in the cwd and stopped, one directory too high.

Two probes added, cwd still first so an app that puts either at its root wins:

```
schema:  --schema  →  config schema:  →  beside the config  →  ./schema.lite  →  ./db/schema.lite
config:  --config  →  ./litestone.config.js  →  ./db/litestone.config.js
```

The config probe matters as much as the schema one: basecamp's `litestone.config.js`
is in `db/`, so finding it also resolves `db:` and `migrations:` rather than the
schema alone. The *No schema found* message now names all four places it looked —
it listed three, and the one people expected was not among them.

## 2026-08-14 — a policy may compare an encrypted column

`FJS-214`. `@@allow('read', owner == auth().email)` over an encrypted `owner`
emitted `"owner" = ?` bound with the plaintext address while the column held
ciphertext, so the owner read their own row and got `[]`. It failed **closed**,
which is why it survived: a model that denies every row to every caller looks
exactly like a table with no data.

A `where` had never had the problem, because `buildWhereWithEncryption` rewrites
the operand to the encoding the column uses before comparing. `policy.js`
contained no reference to encryption at all — the same translation, made in one
place and not the other.

**`comparisonEncoderFor()` is now the one owner of that translation**, in a new
`src/core/encryption.js` that also holds the primitives client.js used to keep
private. Both callers ask it rather than deciding: `rewriteEncryptedWhere` for a
filter, `compileSql` for a predicate. They cannot drift apart again, and the
encoder is chosen once per column kind rather than twice.

So a policy over `@hashed` or `@encrypted(deterministic: true)` answers, on
every operation that compiles to a WHERE:

```
model Doc {
  owner String @hashed
  @@allow('read',   owner == auth().email)
  @@allow('update', owner == auth().email)
}
```

**The startup refusal stays for the shapes an encoding cannot answer, and now
says which one.** Plain `@encrypted` stores a random IV, so the same value
writes different bytes every time and no operand can be encoded to match it; an
operator other than `==` / `!=` asks for ordering neither encoding preserves;
and a column compared against a column has no value to encode. Before, the check
refused the mere presence of the field, which is why the two modes that do work
were refused along with the one that does not.

`create` is exempt — it is evaluated in JS against the data as written, which is
still plaintext, so every comparison form works there. `post-update` is refused
instead, and that is new: it is evaluated in JS too, but against the row read
**back**, where an encrypted column is `@guarded(all)` and stripped — so the
comparison would be against `undefined` and would roll back every write.

Verified with rows on both sides of the predicate, in both modes, plus the
`example` and `basecamp` drives and sierra's `test:safety`.

## 2026-08-14 — `backup` copied the wrong databases; `replicate` covered one

`FJS-246`, `FJS-242`, `FJS-243`. Found by making `replicate` schema-driven and
hitting the same wall `backup` was already standing behind.

**`createClient({ db })` names MAIN and overrides a declared `database main`**,
and `loadConfig()` always answers a `db` — `./development.db` when nothing said
otherwise. Six commands forwarded it blindly: studio, seed, optimize, backup,
replicate, db push. So `litestone backup` opened a client at a file the schema
never named, createClient created it, and the empty result was snapshotted as
`main` with a `✓` beside it. Proven with a marker row — the backup did not have
it, the real database did.

Underneath that, the SQLite arm reopened a client **per database**:

```js
createClient({ parsed, db: info.path })   // ← still names MAIN
```

so each client was main-at-another-database's-path *and* held every declared
SQLite connection open, which tripped `$backup`'s multi-database branch. The
output was `bk/main.db/` and `bk/analytics.db/` as **directories**, each holding
a copy of both, and `bk/analytics.db/main.db` was analytics filed as main.

Fixed at the owners rather than at the call sites. `declaresDatabases()` /
`clientDb()` is the rule `openSqliteDbs` has always applied for the migrate
commands, now shared: **when the schema declares databases, the declaration owns
the paths.** `$backup(dest, { only })` lets one client answer for one database,
so nothing needs a client per database again. `--db` was overloaded by the same
confusion — a name filter on a multi-database schema, a path on a single one —
and read as a name it matched nothing (`No databases found matching --db=./app.db`).

**This is what a deploy's `05-backup` calls for its pre-migration snapshot**, so
the one guard against a bad migration was writing a wrong or empty file and
reporting success. It sits directly beneath `FJS-240`, which made a *partial*
backup fail loudly; this one was not partial, it was wrong.

**`litestone replicate` is schema-driven now**, the same resolution for the same
reason — it read one `db:` path out of a transform-pipeline config, so an app
with a `main` plus an `audit` logger replicated its rows and silently not its
trail. One `dbs:` entry per declared SQLite database, each to `<url>/<name>` so
two databases cannot overwrite each other's generations:

```
litestone replicate --schema db/schema.lite --url s3://bucket/myapp
litestone replicate --db main
litestone replicate ./litestone.config.js
```

`--schema` and `--url` mean it runs against a scaffolded app with no config file
at all, which is what it could never do before. Resolution moved to `cli.js`,
which owns `loadSchema`/`createClient`; `replicate.js` is the litestream driver.

**Litestream replicates SQLite, so a jsonl or logger database cannot be covered
at all** — reported by name with what to use instead, because a replication
report that lists only what it did reads as though it did everything.

**And it refuses litestream below v0.5.** Not a warning: this machine carries
v0.3.4, and against a litestone database it starts, announces `replicating to:`,
then loops forever on

```
sync error: malformed database schema (user) - near "STRICT": syntax error
```

because litestone emits STRICT tables and 0.3.x bundles a SQLite too old to
parse them. It never exits — a live process, an empty replica, and every deploy
check in the repo saying healthy because they ask `pgrep`. `LITESTREAM_BIN` is
the hatch. Litestream is not forked or republished (`DECISIONS.md` `FJS-D31`);
this is how the version is controlled without becoming its distributor.

## 2026-08-14 — `$transaction` is safe under concurrency

Two concurrent `$transaction` calls silently became one. The depth counter is per
CLIENT and one connection holds one transaction, so *am I nested?* could not be
answered by the counter: a second REQUEST arriving while the first awaited looked
exactly like a genuinely nested call, and was treated as one.

```
A: begin()  → depth 0→1, BEGIN IMMEDIATE, awaits
B: begin()  → sees depth 1 → SAVEPOINT sp_1 INSIDE A's transaction
B: commit() → RELEASE sp_1        ← B's caller is told it succeeded
A: rollback → ROLLBACK            ← B's rows are gone
```

B could also read A's uncommitted rows, because the read router sends every read
to the write connection while `depth > 0`. Reproduced before fixing.

**Re-entrancy is now asked of the async context, not the counter.** A module-level
`AsyncLocalStorage` holds the `txState` objects the current context owns, so a
nested call — which runs inside the outer callback and inherits the store — still
takes a SAVEPOINT, and anything else waits on a per-client FIFO lock. Both halves
matter in opposite directions: serialising everything would deadlock a genuine
nesting (basecamp's `/setup`, four models deep), and nesting everything is the
original defect.

`tx.wrap` — the **synchronous** batch wrapper behind `createMany`/`upsertMany` —
had the same hole. Its callers are already async, so the acquire is awaited while
the batch body stays synchronous.

This serialises only what SQLite already serialises: two `BEGIN IMMEDIATE`s
cannot overlap on one connection, and the old code avoided the error by enrolling
the second caller in a transaction it could not see. `FJS-244`.

## 2026-08-13 — `litestone backup` no longer calls a partial copy a success

`FJS-240`. Every failure arm in `cmdBackup` logged and continued — a `$backup`
throw, a logger directory that is not there, a failed zip — and then the summary
line printed unconditionally and the command exited 0.

Found by pointing a deploy's pre-migration snapshot at it. From the wrong
directory it copied `main`, warned on `audit`, printed `✓ backup complete` and
returned 0. **Database paths resolve against the process CWD, not the schema
file** — `example/db/schema.lite` says so in its own comment — so the wrong cwd
gives a partial backup rather than an error, and over SSH nobody reads the ⚠,
only the exit code.

It now collects what did not make it and refuses:

```
✗  backup INCOMPLETE   1 of 2 database(s) not backed up
   audit (…/db/audit not found — paths resolve against CWD)

Whatever was written is a PARTIAL copy. Do not treat it as a restore point.
```

Exit 1. The success path is unchanged, which is the half that had to be checked
too: from the app root with `--schema db/schema.lite`, `example` backs up `main`
and `audit` and exits 0. 1954/1955 suite unaffected.

## 2026-08-13 — Schema Advisor: a fix that edits the schema, and a corrected reason

**The advisor's stated reason for indexing a foreign key was backwards.** It claimed
`include({ environment: true })` would scan — that reads the *parent* and resolves by
primary key, and `EXPLAIN QUERY PLAN` confirms it never scanned. What scans is
everything starting from the other side: the parent's `hasMany`, a `where` on the FK
column, and `ON DELETE CASCADE`. Right conclusion, wrong argument, which is the kind
of advice that teaches the wrong model of the database.

The conclusion is now backed by numbers rather than assertion, measured on 50k rows:
2,000 lookups by the FK are **4,023ms unindexed against 56ms indexed**, a cascade
delete of 200 parents **656ms against 8ms**, bought for 1.7× on insert and ~60% more
disk.

**An issue that has a known fix now carries it as data** (`fix: { kind: 'index',
model, columns }`) and Studio renders a button that writes `@@index([col])` into the
right model in `schema.lite` — brace-depth located rather than regex-matched, since a
doc comment inside a model may contain braces; indentation taken from the block;
placed with the other `@@` attributes; parsed before saving; duplicates refused.

**It deliberately does not create the index.** The schema now states something the
database does not, so the toast says `migrate to create it` and offers the Migrations
panel, and the advisor keeps reporting the issue until a migration builds it. The raw
`CREATE INDEX` stays for a database you cannot redeploy, but the schema is the better
route for the reason above: a migration only drops what litestone named.

`bench/studio-advisor-fix.mjs` ends where it should — after the edit it builds a
migration from the edited schema and asserts SQLite now answers
`SEARCH deployment USING INDEX idx_deployment_environmentId (environmentId=?)`.
Asserting the text landed in the file would prove the button typed, not that it
helped.

## 2026-08-13 — Studio's schema advisor was reporting every foreign key as unindexed

**It queried `sqlite_master` by MODEL name.** `WHERE tbl_name = 'User'` against a
table created as `user` — SQL string equality is case-sensitive even though SQLite
resolves identifiers case-insensitively — matched nothing, so the advisor saw zero
indexes on every model and reported **all 48 FK columns on basecamp** while 60
indexes existed. It also called every declared `@@index`/`@@unique` "pending, run a
migration". Reported from Studio against a `User` whose schema declares
`@@index([accountId])` and whose database holds `idx_user_accountId`.

Four more defects in the same twenty lines, each found by the one after it:

- **Implicit unique indexes were invisible.** The query filtered `sql IS NOT NULL`,
  and an index SQLite creates for a `@@unique` has `sql = NULL`. Now read through
  `PRAGMA index_list` / `index_info`, which also returns columns already ordered
  instead of a regex over DDL text that has to survive partial-index predicates.
- **Every column of an index counted as indexed.** SQLite uses a leftmost prefix, so
  an index on `(workspaceId, userId)` does nothing for a lookup on `userId` — a
  false negative hiding a real scan, which is what a performance advisor exists to
  find. `WorkspaceMember.userId` is a true positive it was missing.
- **Suggested SQL used a name litestone does not manage.** `CREATE INDEX
  "User_accountId_idx"` is Prisma's convention; a migration only drops what it
  named (`idx_<table>_<cols>`), so following the advice left an index no later
  migration would ever touch. The note now says to declare `@@index([col])`.
- **Multi-database and tenant handles were mixed.** Indexes were read from the base
  connection while row counts came from the active tenant's, and a model in a
  `logger`/`jsonl` database was audited for SQLite indexes it cannot have.

`bench/studio-advisor.mjs` grades every verdict against `EXPLAIN QUERY PLAN` in
**both** directions — a checker that only proves its own complaints cannot catch
what it misses. Two traps the oracle itself fell into and now documents: litestone
always carries `deletedAt IS NULL`, so a probe without it cannot use a partial index
and blames the advisor; and `USING INDEX` is not enough, because SQLite will use
`idx_<t>_deletedAt` for the predicate while still scanning for the column asked
about. 48 reported → 18, then 14, all 14 confirmed real scans.

## 2026-08-13 — Studio: the query behind a view, a generated row, pinned parents

Four additions to Studio and two repairs it turned up, all driven in a real browser
by `bench/studio-{query-view,sidebar,factory,factory-click}.mjs`, which start Studio
and Chrome themselves and work on a tmpdir copy of the database.

**`{ } Query`** renders the Litestone query Browse already builds on every load and
then throws away, to copy or send to the REPL. It emits the **client** alongside the
arguments, because a view browsed as a user and the same arguments through
`asSystem()` return different rows. `findMany` rather than `findManyCursor` — a
pasted opaque cursor means nothing elsewhere, so the query describes page one of the
same filter and sort, and says so when you are past it.

**`🎲 Random`** generates one row from the schema with `factoryFrom` + `withParents`,
runs as the principal the sidebar selects, and reports every table it touched — a
generated `App` on basecamp also writes an Account, Workspace, Project and
Environment, and a button that does that silently is how a scratch database stops
being one. A gate refusal is shown in full with a **Retry as system** offer attached
to the toast; the escalation is never taken for you, and the resulting row says
`(as system)`. The offer is discriminated on `AccessDeniedError`, not on message
wording, so a validation failure gets none.

**Pinning.** `withParents({ pins: { Account: row } })` reuses rows you already have,
keyed by model and applied **at every depth** — which is the whole point, since
`.for()` wires one relation on one factory and cannot reach a grandparent. Studio
exposes it as 📌 on a row's detail drawer plus chips in the toolbar, holding only the
id and re-reading it through the client it is about to write with, so a pin cannot
hand a principal a row its own policy hides.

**`withParents()`'s cycle error gave advice that did not work.** It told you to pass
the root with `.for('parent', rootRow, fk)`, and doing exactly that threw the
identical error, because the cycle guard ran before the check for an
explicitly-wired relation. Both cures — `.for()` and now `pins` — are consulted
first, and the message names both.

**Four `onclick` handlers were dead**, found because a fifth one written the same way
did not fire. `onclick="fn(${JSON.stringify(x)})"` inside a double-quoted attribute
ends the attribute at the JSON's first quote, so the browser saw `copyCell(`. It
silenced the ⎘ copy button on **every grid cell**, both `open →`/`view →` links in
the row-detail drawer, and Copy SQL on a diagnostics issue. `esc()` already existed
and two neighbouring call sites already used it. Nothing threw, in any of them.

**The sidebar could not scroll.** `.app` clips its overflow and nothing below it
declared `overflow-y`, so basecamp's 38 models pushed the Tools nav past the fold and
out of reach. The table list scrolls now and the fixed sections stay put; `min-height:
0` is what makes a flex child shrink at all. A first fix passed at 700px and gave a
**0px-tall table list** at 420px — the list being the only shrinkable child — so it
also carries a floor, and the drive runs at five viewport heights.

## 2026-08-13 — `@encrypted(searchable: true)` is gone; `@encrypted(deterministic: true)` and `@hashed` replace it

**The old attribute stored an HMAC and no ciphertext, under a name that promises
the value comes back.** The plaintext was destroyed on write, `asSystem()` was
handed the digest as if it were the value, and `docs/encryption.md` said it stored
the HMAC *alongside* the ciphertext, which was never true — the example field it
chose was `email`. Following the page lost every address in the table with nothing
thrown at any point. Closes `FJS-211`.

Three modes now, on one axis — **can this value be read back?**

|  | recoverable | not recoverable |
| --- | --- | --- |
| **not filterable** | `@encrypted` (random IV, `v1.`) | — |
| **filterable (equality)** | `@encrypted(deterministic: true)` (`v1d.`) | `@hashed` (`v1h.`) |

The empty cell stays empty: a value you can neither read nor match is a value you
deleted, which is what the old attribute quietly built.

**`deterministic: true`** is AES-256-GCM with the IV derived from the plaintext
under a separate salt, so the same value stores the same bytes and an equality
filter works — and it is still ciphertext, so it decrypts and `$rotateKey` re-keys
it. GCM breaks catastrophically on nonce reuse across *different* plaintexts;
deriving the nonce from the plaintext makes that a hash collision rather than an
accident, and reuse across identical plaintexts is the property being bought. Same
construction Rails ships for `deterministic:`. It trades one thing and the doc says
so: equal values are visibly equal in the column to anyone holding the file. Every
searchable-encryption scheme leaks that, blind indexes included.

**`@hashed`** is HMAC-SHA256 and nothing else — no ciphertext, no key that recovers
it, not rotatable. It is a separate attribute rather than an option on `@encrypted`
because an option inherits its parent's promise. It refuses to compose with
`@encrypted`, `@secret`, `@guarded` or `@allow`, and requires a `String` column.

**Every read path refuses a digest, `asSystem()` included** — there is nothing to
lift the guard to. A row lacks the field; naming it in a `select`, a `groupBy` or an
aggregate **throws**. Those last two are the ones worth stating: they project a
column straight out of SQLite without building a row, so `by: ['token']` answered a
list of digests and `_max` answered one. Handing back something that looks like a
value is precisely how the old attribute lost data — it gets displayed, mailed,
exported and written into the next table before anyone notices the plaintext is
gone.

**`@secret(deterministic: true)`** composes, for a secret that must be both looked up
and rotated. `$rotateKey` now re-encrypts each field in the mode it was **declared**
with; rewriting a deterministic column under a random IV would leave it readable and
every equality filter over it answering nothing, silently, until someone searched.

**The old spelling is refused at parse time, not translated.** The two meanings it
stood in for are the whole decision, and guessing either one silently is how the
value was lost. **A column already holding `v1s.` values is unrecoverable** — an HMAC
has no inverse — so nothing reads the prefix and the migration is re-collecting the
values from wherever they still exist.

Both matchable modes share one WHERE rewrite (encode the operand the way the column
was encoded) and one refusal for everything else, so the suite asks the same
questions of both rather than trusting the second encoder to have inherited the
first's fixes. `test/matrix.test.ts` gains a `hashed` kind and renames `encSearch` to
`encDet`; its write cells verify by MATCHING the new value, since reading a digest
back is the one thing the column does not do.

Found while building this, filed and not fixed here: `FJS-236` (`$rotateKey` leaves
the client it was called on unable to read its own output, because `asSystem()` is
memoised over a snapshot of the key — predates this work) and `FJS-235`
(`@guarded(all)` blocks reads and not writes, and cannot be paired with
`@allow('write', …)` to cover both).

Also: `src/core/client.js` held a **raw NUL byte** in a `cols.join()` separator, which
made `grep` classify the largest file in the package as binary and skip it in silence.
It is the `'\x00'` escape now — same string, and the file is searchable again.

## 2026-08-13 — one clock per evaluation, and it can be frozen

`now()` in a policy expression resolved at the point it was **reached**, so
`@@allow('read', startAt < now() && now() < endAt)` bound two timestamps
microseconds apart, and `evalJs` called `new Date()` again on its own side.
Harmless for an access check, wrong in principle, and fatal for the reporting
shape the `@@scope` ruling depends on: a query with no single "as of" instant
can return a row satisfying a contradiction and will not reconcile with a
re-run. It is now resolved once per evaluation, carried on a prototype view of
`ctx` so every nested compile — a `check(field)` delegation recurses — reads the
same moment.

**`createClient({ now })`** is the injection point, taking a function returning
a `Date` or an ISO string. It reaches both halves of the policy compiler and
`@@softDelete`'s stamp, so a frozen clock freezes every timestamp litestone
writes rather than only the ones a policy compares against. That is what makes
a time-dependent test deterministic and a report reproducible, and it is the
prerequisite the `FJS-D28` ruling named before `@@scope`/`@@order` can land.

Closes `FJS-227`.

## 2026-08-13 — `@from(first/last)` returns a row that was actually read

`@from(Order, last: true)` built the row as `json_object('field', …)` over the
target's columns. That list filtered out the **virtual** attributes — `@computed`,
`@from`, `@generated` — and left the **protective** ones alone, because those are
applied by `read()` and a hand-built JSON object never reaches it. So the one
`@from` shape that returns a row returned it raw: `@guarded(all)` and `@omit(all)`
values in plaintext and `@encrypted` ciphertext, to an ordinary scoped caller,
while the target's own derived fields were missing.

The subquery now resolves the row's **id** and the row comes back through a real
read of the target — the same move as the recursive walk a day earlier, for the
same reason. Three ways to one row now produce one shape, which is what the test
asserts: a direct read, an `include`, and a `@from(last: true)` agree key for key.

Batched: one query per field across every row in hand, so a `findMany` of a
hundred parents costs one extra query. Resolution happens before `applyComputed`,
so a `@computed` on the *parent* reading `row.lastOrder.amount` still sees a row.

**Two behaviour changes.** The target's row policy now applies, as it always did
to an `include` — a `@@allow` on the target can make the field `null`. And the
default `orderBy` for `first`/`last` is now the **target's** id column; it was the
declaring model's, which is the same name often enough to hide the difference.

The three include branches each finished their rows with their own copy of
deserialize → compute → shape; they now share one `finishRelated`, which is why
the fix reached all three rather than only the one that was tested.

Closes `FJS-222`, `FJS-223`. Opens `FJS-224` for the residue: the pick is made
before the policy is known, so a denied row is `null` rather than the next
visible one.

## 2026-08-12 — `@from` reads the relation you meant

**A `@from` on a relation to the same model answered `0`, always.** The subquery
correlates a table to itself, and unaliased the correlation was captured by its
own scope: `(SELECT COUNT(*) FROM "task" WHERE "taskId" = "task"."id")` reads
that `"task"."id"` as the **inner** row, so it counted rows whose FK equalled
their own id — none. A parent with two children read `childCount: 0`, typed,
present and wrong. The target is now aliased in every `@from` subquery, not only
when the names collide: a rule that holds conditionally is a rule with two
implementations, and this one already cost a silent wrong answer.

**An ambiguous `@from` is refused rather than resolved by declaration order.**
Two relations can join one pair of models — `sender`/`recipient` both point at
`User` — and `@from(Message, count: true)` took whichever came first in the file
and said nothing. The other count was unaskable, and the one you got answered a
different question with nothing in the value to distinguish them. It is now a
schema error naming both candidates and the cure, and **`via:`** is the cure:

```prisma
sentCount Int @from(Message, count: true, via: sent)        // the field on this model
gotCount  Int @from(Message, count: true, via: recipient)   // or the one on the target
```

`via` names either side — the field here, the field there, the `@relation` name
they share, or the FK column. A name matching none is refused with the candidates
listed. The word is `recursive`'s, deliberately: it is the same question about
the same kind of ambiguity, and a second word for it would be a second thing to
learn.

`parent` + `children` is one relation and still needs no `via`. Nothing in this
repo's seven schemas is newly refused.

Closes `FJS-220`, `FJS-221`.

## 2026-08-12 — a tree read is a read

`findMany({ recursive })` was a second implementation of `findMany`. It built
its own SQL and returned before the plugin runner, so `@@gate` was never asked;
it composed the row policy and the soft-delete filter into the CTE's **anchor**
SELECT and nowhere else, so every row below the row you named arrived
unfiltered. A caller refused on a model could read its whole subtree by asking
for the children of a row it could see. Fail-open, and it broke Invariant 6 for
one option of one method.

The fix was to delete the second read path rather than thread three filters
through it. The CTE now resolves **ids only** and the rows come back through the
ordinary `findMany`, which is what applies the gate, the select, the includes
and the derived fields — one owner each, instead of a copy here that had drifted
out of all four. The walk carries the same visibility predicate as the anchor,
so a node the caller cannot see hides its subtree; that is the deliberate
reading, matching what `@@softDelete(cascade)` already does on the write side,
and the alternative reparents orphans up into the visible tree.

Three things that were silently ignored now say so. `count`, `findFirst`,
`findUnique`, `exists`, `aggregate` and `groupBy` **refuse `recursive` by
name** — `count({ recursive })` counted the anchors and answered a plausible
number for a question nobody asked. `nested: true` refuses `limit`/`offset`,
which would cut branches out of the middle of a tree. And `select` is honoured,
where before a caller that narrowed its read got every column back.

**A row can no longer be made its own ancestor.** The write is refused naming
the field, which is the only place that can — nothing about a tree read can say
which of a thousand rows was pointed at wrongly. A loop already stored is
survived rather than trusted: the walk tracks the path it came by. The `GROUP BY`
that dedupes the answer means the path column changes no result, only the work —
without it a two-row loop is ended by the depth ceiling alone, so it scans
`maxDepth` rows.

`_depth` is now the distance from the anchor in **both** directions (it started
at 1 walking up and 0 walking down), the anchor is never in its own result, and
`orderBy: { _depth }` works — it was written into the old path but unreachable,
because the orderBy validator rejected the key before the branch ran.

Closes `FJS-216`, `FJS-217`, `FJS-218`, `FJS-219`. Nothing in this repo declares
a self-relation, which is why all four survived: the feature had documentation
and eleven tests, and no drive.

## 2026-08-12 — a filter that cannot match now says so

`$checkWhere` gains `reason` and `message`, matching `$checkOrderBy`'s contract
exactly — `'computed'`, `'encrypted'` or `'unknown'`, so a boundary can say a
different sentence for each, and `allowed` now lists only keys that can actually
be filtered rather than every field name. `filterableKeysFor()` is the sibling of
`sortableKeysFor()` and the one definition of the split; both `$checkWhere` and
the per-query check ask it, so the rule cannot grow a second copy. A relation
stays filterable — `posts: { some: … }` is a legal where.

On a read an unfilterable key warns. On a **write** it throws, which is what an
unknown key already did: an `updateMany` that quietly touches no row is worse
than one that says why.

**Two predicates are refused when the client is built, not per query.** A global
filter and a `@@allow` are each named once and used for every read, so a mistake
in one is permanent and invisible — the model reads as empty for every caller
forever, which looks exactly like a table with no data. Both are decided by the
schema alone, so both are answerable at startup, which is also the only altitude
where the fix is a schema edit rather than a caught exception. The static filter
form is checked; the function form takes a `ctx` and cannot be judged without
one, so it still goes through the per-query check.

The policy case turned out to be broader than the read case. `policy.js` contains
no reference to encryption at all, so a predicate comparing **any** `@encrypted`
field — searchable or not — compares plaintext against stored bytes and denies
every row. A `where` on the same field works, because `buildWhereWithEncryption`
rewrites the operand first. Guarded here, tracked as `FJS-214`, because the real
fix is one owner for *compare a value to an encrypted column*.

What made the `@computed` case worth refusing rather than warning: SQLite reads
an unresolvable double-quoted identifier as a **string literal**, so
`WHERE "comp" = ?` is a comparison of two constants — `{ comp: 'A' }` matches
nothing and `{ comp: 'comp' }` matches **every row**, including rows whose
computed value is something else. Not "fewer rows you can see": a wrong answer in
the dangerous direction (`FJS-215`).

**Tier 3, ruled: an unfilterable key throws on a read too.** Not because silence
is untidy, but because the alternative is not "fewer rows" — SQLite reads an
unresolvable double-quoted identifier as a string literal, so `{ comp: 'A' }`
answers nothing and `{ comp: 'comp' }` answers **every row**, including rows whose
computed value is something else. A filter returning rows that do not match it
cannot be reported by a warning in a log nobody reads.

**An unknown key still only warns on a read.** That trade was ruled on separately
and its rationale holds: a typo returns fewer rows and leaves something to
notice. A key that is real, spelled right and impossible leaves nothing. Two
tests asserted the old silence as expected and were rewritten; nothing else in
1,895 tests moved, which is the argument that the change is scoped.

**`@encrypted(searchable: true)` now answers every spelling of equality.**
`rewriteEncryptedWhere` hashed the scalar form only — `typeof val !== 'object'` —
so `{ in: [x] }` compared plaintext against digests and answered nothing, and
`{ not: x }` answered **every row, the excluded one included**, because a
plaintext never equals a digest. `equals`, `not`, `in`, `notIn` and the
bare-array shorthand each hash their operands now; an operator a digest cannot
answer is refused naming the field, since a digest preserves equality and nothing
else.

19 tests across the three tiers, mutation-checked.

## 2026-08-12 — six silences, found by the matrix and closed

**A plain object in a bind position dropped every binding in the statement.**
`bun:sqlite` reads one as a bag of *named* parameters, and a statement built with
positional `?` matches none of its keys — so it ran with nothing bound, **the
WHERE included**, and raised no error. `SELECT ? IS NULL` given `{x:1}` answers
`1`. That one fact produced four unrelated-looking symptoms: `update` returned
`null` (its WHERE had been voided, so it matched no row, which litestone reports
as *no such row*), `updateMany` said `NOT NULL constraint failed` about a column
whose value was never bound, `create`/`upsert` threw the driver's raw
`Binding expected string, TypedArray, …` naming no field, and a **read** answered
`[]` — the worst of them, because a read has no `changes` to notice. Now refused
naming the field, on reads and writes alike, and the write message says litestone
has no atomic update operators, since `{ views: { increment: 1 } }` is the shape
that gets here (`FJS-D27` asks whether it should have them). Functions and
symbols are named on the write path too rather than left to the driver.

**A `@computed` or `@generated` field is refused instead of dropped.** Both were
absent from the writable-key set, so a write naming one went out through the
*unknown-key* strip — which is silent by design, because that strip is the
mass-assignment protection. Declared-but-unwritable is a different thing wearing
the same clothes, and the caller has to hear about it: the refusal says which
kind it is. An unknown key is still stripped without a word.

**`updateMany` with nothing left to set emitted `UPDATE "t" SET  WHERE …`** and
SQLite answered `near "WHERE": syntax error`. Reachable from an ordinary form post
whose fields no longer match the model — again because stripping unknown keys is
the protection working. It now answers the matched count, which is what `update`
already did with the same input. SET and WHERE parameters are collected in
separate arrays and joined at the end; sharing one made the statement depend on
which half was built first, which is why the case could not be handled where it
belonged.

**`in` and `notIn` now read an array column's elements.** `filtering.md`
documents the bare array as meaning `in`, and after FJS-189 the shorthand
answered while its own explicit spelling did not — `{ words: ['x','y'] }` found
the row and `{ words: { in: ['x','y'] } }` found nothing. The bare-array branch
had `arrayFields` and the `in` branch was never given it.

**`groupBy` and `aggregate` hydrate the values they return.** They handed back
SQLite's own, so an array column came back as its JSON text, a `Boolean` as `0`/`1`
and a `Json` as a string — a value's TYPE depended on which method asked for it.
Applied only where the value is still in the column's domain: the `by` keys and
`_min`/`_max`. **Not** `_sum`/`_avg`, where the number is no longer of the
column's type — the sum of a Boolean column is a count, and coercing it back would
answer `3` as `false`.

**An unknown where operator names its field**: `Unknown where operator "tier" on
field "meta"`, not `Unknown where operator: "tier"`.

`@encrypted(searchable: true)`'s documentation said it stores an HMAC "alongside
the ciphertext". There is no ciphertext — the column holds the digest and nothing
else, so **the plaintext is destroyed on write and cannot be read back**. The
behaviour is deliberate and asserted by a test; the page now says so in a warning
before the example, and no longer uses `email` as that example. Whether the
attribute should keep the `@encrypted` name is `FJS-211`.

Closes FJS-199, 203, 208, 209, 212, and half of 206. 26 tests, mutation-checked.

## 2026-08-12 — the crossing matrix

`test/matrix.test.ts`. Every defect found in this sweep was a **crossing** — two
features that each work alone, whose intersection nobody owned and nobody tested.
An enum that is also an array. An array reached by a `where`. An array given a
`@default`. A bulk write over rows of different shapes. Feature-by-feature tests
cannot find these, because each feature passes its own suite.

So the crossings are declared as a grid, 14 column kinds × 12 operations, under
one invariant: **no cell may silently return a wrong answer.** A cell is
supported, or it is refused *by name* — the runner checks a refusal actually
contains the field name, because a raw SQLite message is a refusal nobody can act
on. Silence is the only outcome never allowed, being the one a caller cannot see.

**A known defect is a cell, not an omission.** `200:ref` means *FJS-200, and this
should refuse*; the runner asserts the defect is **still there** and goes red when
it is fixed, naming the cell and telling you to promote it. Same ratchet as the
typecheck baselines, and the reason a fix cannot leave the grid stale — the
register went wrong in the closing direction before (`FJS-043` sat open for eight
days after being fixed), and a grid nobody re-grades would do it again.

Every declared kind × every declared op must have a cell; a missing one fails
rather than being skipped. Adding a column kind means answering the question
twelve times. That is the point — it makes a crossing somebody's job.

The grid was filled from what the code **does**, not what it should do:
`MATRIX_REPORT=1 bun test test/matrix.test.ts` prints the observed grid ready to
paste. Filling it by hand from belief is how a grid ends up asserting a wish.

It found eight defects on its first run, three of them silent — `FJS-208` through
`FJS-212`, plus evidence that widened `FJS-201`, `FJS-203` and `FJS-206`. The one
worth naming here: `@encrypted(searchable: true)` stores only an HMAC, so the
plaintext is **destroyed on write and unrecoverable**, while `encryption.md` says
it is kept "alongside the ciphertext" (`FJS-211`).

Relation kinds, `@edge`, `@sequence`, `File` and the cursor/window/FTS operations
are **not** in the grid yet, and the file says so rather than leaving the gap
silent.

## 2026-08-12 — `sampleWrites()`

One seeded row per model, plus the payloads a create and a patch would carry, with
every required FK pointed at a parent the same call made. The Data-realm half of
deriving a call list: mapping a model onto the service that exposes it is an
API-realm fact this package cannot see (Invariant 1), so what comes back is keyed
by model name and the caller does the mapping. `@frontierjs/testing`'s transport
parity runner is the first consumer.

Server-owned columns are absent from the create payload — over the wire they are
`readOnly` in the model's JSON Schema, so sending one is a 400 about the fixture
rather than an answer about the rule under test.

**A model that cannot be seeded comes back as `{ error }` rather than being
dropped.** An absent key reads as *this model has nothing to test*, which is how a
derived suite silently stops covering the model whose fixture broke.

It builds its `withParents()` chains through the existing memoised `_chains`, so
it does not re-enter the sequence trap that has now cost four rounds of false
results.

## 2026-08-12 — `env.verifyRowPolicies()`, and `litestone mutate`

**A gate refuses and a policy filters**, which is why this needed its own runner
and why it was the last mutant nothing could see: deleting an `@@allow` raises
nothing anywhere. It returns MORE rows, and more rows is not an error — it is a
disclosure with a 200 on it.

**The oracle is a second implementation, not a restatement.** Litestone compiles
a policy twice, into two languages: `compileSql` for reads (a WHERE) and
`evalJs` for creates (JavaScript). This reads rows through the compiled WHERE and
asks `evalJs` which should have come back. That is the opposite of the oracle
problem — and the same comparison found `field == null` compiling to
`"col" = NULL` while the JS side was right (FJS-195). Verified by reverting that
fix: 3 mismatches.

Covers `read`, `update` and `delete`, all of which compile into a WHERE.
**`create` is deliberately absent**: it is checked by `evalJs` and nothing else,
so grading it with `evalJs` would be circular and there is no second
implementation to compare against.

**Rows are placed on both sides deliberately**, with values taken off the
predicate itself — the principal's own value for an `auth()` comparison, the
literal for a literal one. Three things had to be right for that to work, each
found by running it against basecamp:

- **the field is usually a FOREIGN KEY.** `workspaceId == auth().workspaceId` is
  the whole of basecamp's tenancy, so a made-up value breaks the FK and the row
  never exists. Every matching-side candidate was lost that way, leaving one row
  with all of it excluded.
- **a generated sentinel must satisfy the column's own validators**, or the
  insert fails and the row is on neither side.
- **a targeted value and a miss value are not interchangeable.**
  `verifyFieldProtection` seeded with whichever came first and hid the row from
  the very reader it was about to check.

**Rows on one side only are reported, not passed.** A policy that admits
everything and a policy that is not applied at all are the same observation when
every row matches. `example`'s own `title != null` over a required column is
exactly that, and the runner says so.

**`litestone mutate` / `fli test:mutate`** run the sweep by hand and print the
survivors with their line numbers. Not a CI phase: basecamp is 232 mutants at
several seconds each. `--kinds` narrows it.

`example` now scores **97%** with one survivor — a nullable `@unique`, which
SQLite cannot be made to refuse. Both real schemas are clean on all four checks.

## 2026-08-12 — schema mutation testing, and the two checks it demanded

```js
const r = await mutationScore({ schema, build: (text) => createTestEnv({ schema: text }) })
// example: 30 mutants, 97% killed, one survivor, 3s
```

**Mutate the schema, not the code.** Drop a `@@gate`, grade one down, remove a
`@guarded`, widen a `@length`, delete an `@@allow` — then run the suite derived
from the ORIGINAL schema against a database built from the mutant. A `.lite` file
is small and declarative, so the mutation space is enumerable rather than
combinatorial: 30 mutants for `example`.

**Expectations from the original, database from the mutant.** Deriving both from
the mutant is the oracle problem at its purest — drop a `@@gate` and the ladder
loses the rows that would have caught it, so every mutant survives and the score
reads 100%. `verifyGateLadder`, `verifyConstraints` and `verifyFieldProtection`
all take `{ against }` for this.

**The score named two holes and both are now closed.**

- `verifyGateLadder` executes **all four operations**, not just read. Create
  needs a valid row, update and delete need one already there; the factory
  machinery `verifyConstraints` proved out supplies them. Until it did, lowering
  a create or delete gate was a mutation nothing could see.
- `verifyFieldProtection` reads every `@guarded`/`@encrypted`/`@secret` field at
  SYSADMIN(7) and asserts the key is **absent** — and separately that
  `asSystem()` still gets it, because a column absent for everyone is broken
  rather than protected.
- `verifyConstraints` gained `@unique`, the one declared rule whose failing value
  cannot be generated: it has to be taken off a row that already exists.

`allow-drop` still survives. Row policies need rows on both sides of a predicate,
and nothing executed asks — the finding, stated, rather than a gap in a count.

**An `error` row never counts as a kill.** This was worth 36 points. Every mutant
came back with the same 22 error rows and the score read 93% while four mutations
went completely unnoticed. A mutation score that counts its own harness failures
as successes is the oracle problem wearing a percentage.

**Two more traps the runs surfaced, both fixed:**

- *Mutating prose.* `example` reported four surviving `guarded-drop` mutants on a
  model with no `@guarded` field — the matches were inside a doc comment
  explaining what `@guarded` is not. A mutant that edits a comment is behaviourally
  identical to the original and survives everything, so every documented attribute
  name was quietly costing a point. Mutation is now quote-aware and code-only.
- *A schema the framework will not LOAD is a kill, not an error.* `parse()`
  accepts a non-monotonic `@@gate("4.3.4.5")` and the gate plugin refuses it at
  construction, so the two halves of "is this schema legal" do not agree and only
  the second is reached.

**A row policy makes one direction ungradeable, and only one.** A policy filters,
so it can turn an allow into a deny and never the reverse — `Server.create` on
basecamp reports `allow` from the schema and `deny` from the client, and the
policy is the correct answer. Skipping BOTH directions cost a real kill: a
lowered read gate on a model that happens to declare an `@@allow` stopped being
graded at all.

Clean on `example` and `basecamp`. Basecamp's ladder takes ~5.7s (37 models × 4
ops × 9 levels, with a restore between rows) — an audit, not a unit test.

## 2026-08-12 — `env.verifyConstraints()`

`verifyReadLadder`'s sibling. `generateGateMatrix` and `generateValidationCases`
both **describe** a schema, and describing is where a generator's value stops;
this executes the constraint cases against the real write path and returns the
ones that disagreed.

```js
expect(await env.verifyConstraints()).toEqual([])
```

**The oracle is structural, not textual.** The schema declares a rule, so a value
violating it must be refused — the message is not asserted, which is what keeps
the expectation independent of the code producing it. A rule that reaches the
browser through `x-messages` and is ignored by the server is what it exists for.

Runs as SYSTEM, because the question is enforcement and a `@@gate` refusing the
write first would answer *rejected* for every case including the ones nothing
validates. Rolls its rows back, so it is safe to call mid-suite.

**Three outcomes, not two.** A write that fails for an unrelated reason is
`error`, never `rejected` — calling it a refusal is the trap, because it makes a
broken validator look enforced. It is reported rather than swallowed: a case that
could not run is a hole in the coverage the count implies. A model whose row
cannot be built at all (a required self-reference) reports once and the run
continues.

**Three collision guards, each measured on basecamp's 37 models.** One factory
clone per model (a re-clone writes sequence 1 every time); `fresh: true` parents
(reused parents give identical FKs and collide on a `@@unique` over them — 1
case); and a restore between models (two models sharing a parent each build one
from their own seq 1 — 57 cases). Every one of those failures looks exactly like
the validator working, which is why the `error` outcome had to exist before the
runner could be trusted. Its first run on basecamp reported 23 mismatches, none
of them about basecamp.

Clean on `example` (22ms) and `basecamp` (157ms). Mutation-checked against both:
disabling `@gte` reports 2 and 10, `@email` 1 and 1, `@length` 8 and 46.
Basecamp's own suite now asserts it.

## 2026-08-12 — `field == null` in a row policy (FJS-195)

`@@allow('read', ownerId == null)` compiled to `"ownerId" = NULL`, which SQLite
answers NULL — never true. So the policy hid every unowned row and raised
nothing: an empty list with a 200, which is the failure mode `@@allow` has by
design and the reason a wrong one is so hard to see.

Worse than half-wrong. `create` is evaluated by `evalJs`, which compares with
`===` and had always been right, so a caller could create a row and then not see
it — the two halves of one rule disagreeing. The `auth() == null` form was
already special-cased in both paths; the `field == null` form was in neither.

Now emits `IS NULL` / `IS NOT NULL`, resolving a `belongsTo` field to its FK the
same way `field == auth()` does. Found by the first vertical test through
`@frontierjs/testing`, whose fixture schema wrote the natural thing. 3 tests,
mutation-checked at 3 red.

## 2026-08-12 — `env.setup()`, the hoisted arrange

```js
const fx = await env.setup(({ factories }) => factories.account.createOne())

test('…', async () => {
  const t = env.phases({ as: developer })     // rows are back at fx
})
```

Runs once, snapshots what it wrote, and every later `phases()` call restores it.
The restore is a truncate + bulk re-insert of the exact rows — cheaper than
re-running factories through validation, hooks, gates and FTS. With
template-clone already off the per-test bill, the fixture is what dominates a
suite's runtime, and this is the part that stops paying it per test.

`setup` takes the **same tools** `arrange` takes, so hoisting a line out of a
test is a move rather than a rewrite. The value it returns survives the restore:
rows go back with the ids they had.

Refused twice, and refused after the first scenario has run. Both are one
failure — a baseline that does not describe what the tests around it started
from — and it is order-dependent, so nothing else would catch it.

`seal`/`reset` are untouched and keep their own snapshot; `phases()` restores
`setup`'s baseline and nothing else. Mutation-checked: dropping the per-scenario
restore or the second-setup guard turns one test red each.

## 2026-08-12 — `readOnly` and `env.phases()`

**Arrange / Act / Assert as three different clients rather than three comments.**

```js
const t = env.phases({ as: developer })
const lead = await t.arrange(({ factories }) => factories.lead.createOne())
await t.act(as => as.lead.remove({ where: { id: lead.id } }))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
```

`arrange` gets the **system** client, so a gate that refuses the principal does
not refuse the fixtures. `act` gets the **principal's** client and runs once —
a scenario with two acts cannot say which one an assertion is about, and setup
after the act is part of the act, which is what would stop `arrange` being
hoisted and cached. `assert` gets the principal's **read-only** client, which is
the pair of properties that phase actually needs: graded, so *the row exists*
cannot stand in for *this user can see it*; and unable to write, which is what
makes retrying a scenario sound.

The body stays linear. Callback phases would thread state through return values
and stop a line being commented out to bisect, and the enforcement does not need
them — it comes from what is in scope.

**`readOnly(client)` is an allow-list, not a deny-list of the writes.** A write
method added to litestone later would pass straight through a deny-list, and the
whole value of this is that it cannot. The doors back out to a writable client
are refused by name: `asSystem`, `$setAuth`, `sql`, `$rawDbs`, `$transaction`.
`asSystem` needed naming specifically — it is the one escape that is not
`$`-prefixed, and it first "passed" only because it fell through to the table
branch and failed as *not a function*, which is an accident, not a guard.

Mutation-checked: turning the allow-list into a passthrough, dropping the
`asSystem` guard, or dropping the one-act rule turns 2, 1 and 1 tests red.

Not tied to a runner — `phases()` is called inside whatever `test()` the package
uses, so bun and Vitest both get it without an adapter.

## 2026-08-12 — the validation generator, run against a real client for the first time

**Nothing had ever executed a generated validation case.** `generateValidationCases`
shipped with unit tests over its *output* and none over whether a client agreed
with it. Running all of them found **five** defects, four of which made the
generator produce tests that fail against a correct implementation.

**`cases.valid` was not valid.** `generateFactory` had no case for `@time`,
`@date` or `@datetime` on a **String** column — those are string formats, not
column types, so `day String @date` got the generic `"Day 1"`. Every case is
built as `{ ...valid, [field]: bad }`, so one such field made *every* generated
case for the model fail, naming a field it was not testing. "Correct by
construction" was a claim with nothing behind it.

**An authored message was ignored.** A field declaring `@email("Use your work
address")` generated a case predicting the DEFAULT wording, so the documented
`rejects.toThrow(c.message)` failed against a client behaving correctly. The
message now comes from the attribute, falling back to the shared table.

Reading `DEFAULT_MESSAGES` is not the oracle problem the gate matrix had, and the
distinction is worth stating: the claim under test is *this value is rejected*,
which is derived here from the attribute's presence. The message is a **label**,
and the table is the one definition of it that Junction and Sierra also read
through `x-messages`. Sharing a label is fine; sharing a verdict is not.

**`@phone`, `@time` and every array rule generated nothing at all** — enforced,
untested, silently. `@minItems`, `@maxItems` and `@uniqueItems` now produce
invalid and boundary cases; arrays were skipped wholesale before.

**The fix that matters is the test, not the five repairs.** Every generated case
now runs against a real client: invalid ones must be refused *with the message
the case predicted*, boundary ones must be accepted, and every field carrying an
attribute must produce at least one case. Mutation-checked — dropping the custom
message, the `@time` factory branch or the array cases turns 2, 3 and 2 tests red
respectively.

Found and filed rather than fixed: **`FJS-194`** — the array validators are
enforced inline in `writeData` rather than through `DEFAULT_MESSAGES`, so
`@minItems(2, "Pick at least two")` reaches the browser through `x-messages` and
is ignored by the server, and the same rule refuses with different wording
depending on which side saw it.

## 2026-08-11 — `createTestEnv`, and a database per test that costs a file copy

**Applying the DDL was the per-test cost, and it produces the same bytes every
time.** `src/testdb.js` migrates once per schema per process into a template and
every client after the first is `copyFileSync`. Measured on basecamp's 37-model
schema: **476ms → 13ms per database**, and litestone's own suite went 41.5s to
33.7s without a test changing. `makeTestClient` uses it too, so the win is not
opt-in. In SQLite, a database per test is a file copy — which makes the isolation
everyone else pays for with transactions cheaper here than transactions are.

**`createTestEnv({ schema })`** is the environment: a migrated database, a
client, factories and a principal in one call. `schema` takes the text or a path.

**Two auth doors, deliberately not one.** `actingAs(user)` grades through the
app's own `getLevel`; `atLevel(n)` grades synthetically for walking the gate
grid. A matrix driven by `atLevel` passes in full while the app's resolver is
broken, because the resolver was never called — so `atLevel` is for the grid and
everything about behaviour uses `actingAs`. `atLevel` opens a second client (a
level is fixed at construction, so it cannot be a property of a call), dropping
any caller-installed `GatePlugin` and keeping every other plugin; `atLevel(8)` is
`asSystem()`, since `getLevel` is clamped to 0–7.

**`migrations:` builds the template by replaying the committed migration files**
rather than generating DDL from the schema — a directory, a `.sql` path, or an
array of either. That is Encore's actual shape, and it is what basecamp's suite
needed: all 61 of its tests are about the database a deploy produces, and they
had been replaying `001_initial_schema.sql` by hand for exactly that reason.
Converting them cut that file's runtime from **58s to 9.5s** and gained a test
nothing had asked before — build a database each way, introspect both, compare.
They agree.

A directory is read more loosely here than `listMigrationFiles` reads one: every
`.sql`, not only litestone's generated `<14-digit>_<label>.sql`. A hand-written
`001_initial.sql` is a real migration, and a template that skipped it would
produce an empty database and a wall of *no such table*. A `.js` migration is
refused by name rather than skipped — it is handed a client, and a template is
built on a raw connection. `migrationStatements(path)` is exported from
`core/migrations.js` so the comment-and-transaction stripping has one owner
rather than a second copy in the template builder.

**`verifyReadLadder()` runs the read column of every gated model at every level
against a real client, with no fixtures** — a read either refuses or answers.
333 assertions on basecamp in 214ms. Each mismatch is a sentence naming the
model, the operation and the level.

### The oracle has to be independent of the thing it grades

The first cut had `gateLadder()` ask `levelPasses()` for its expected verdict —
one definition, no duplication, and the reasoning that got it there was the same
reasoning that made `levelPasses` an export in the first place. It was wrong.
Deleting a branch from the plugin outright produced **zero mismatches across 333
executed assertions**, because the expectation moved with the enforcement.

`expectedVerdict(required, level)` in `access.js` now states what `@@gate` means,
and deliberately does not call `levelPasses()`. One exhaustive test over every
(required 0–9 × level 0–8) pair holds the two statements together, so a
divergence fails there — loudly, in one place — instead of silently disarming
every suite downstream. Re-run against a real off-by-one (`>=` → `>`): 34 of 333
mismatches, each naming its model and level.

The distinction is between describing and verifying. The access snapshot
describes what the plugin enforces and should share its predicate. A runner
grades the plugin and must not.

**Also fixed while writing its test: a read that throws for a non-gate reason
was counted as a refusal.** An `@@external` model emits no DDL, so every read
fails with *no such table* — and the ladder called that a pass at all six levels
its gate refuses. Only an `AccessDeniedError` counts as `deny`; anything else is
reported as `error` regardless of what the schema expected.

## 2026-08-11 — `litestone access`, and a gate matrix that covers the ladder

**A schema's access rules were only readable by reading the schema.** `@@gate`
refuses and `@@allow` filters, both below the API, and a wrong policy is an empty
screen with a 200 rather than an error — so a gate that moved was invisible until
something was refused in production.

`litestone access` writes `access.snapshot.md` beside the schema: gates per model
per operation, each row policy as the predicate it was written as, protected
fields, and gated transitions. Commit it and read its diff. `--check` re-derives
and exits 1 when the committed file is stale, which is the half that makes it a
gate rather than a document. `--json` gives the structured table.

Two properties are load-bearing and both are pinned by tests. Models render sorted
by name rather than in schema order, and empty sections are omitted — a model
inserted mid-file otherwise shifts every row below it and the diff stops naming
what changed. And the render is byte-deterministic, because `--check` compares the
whole file and a check that cries wolf gets disabled.

**`generateGateMatrix` now covers the whole ladder.** It emitted two cases per
operation — the required level and the one below — which proves the comparison
operator and nothing else; a gate granting at 6 and again at 2 passed. The default
is now every operation against every reachable level (0–8), 36 cases per model,
with `{ levels: 'edges' }` for the old shape. Cases carry `required` alongside
`level`.

Verdicts come from `levelPasses(required, userLevel)`, newly exported from the gate
plugin and now the single definition of "does this level pass this gate" —
`checkLevel` guards on it and keeps its three distinct messages. Anything that
*describes* a gate rather than enforcing it asks that function, because a second
copy is an artefact certifying access the plugin does not grant.

Also fixed: two usage comments and two doc examples called these generators with an
accessor (`'posts'`, `'leads'`) where the code matches on the model name and throws,
and `docs/testing.md` showed the level being passed on the user object
(`$setAuth({ id, level })`), which the plugin ignores — the level comes from
`getLevel`, clamped to 0–7, so SYSTEM is reachable only through `asSystem()`.

## 2026-08-11 — a bare array in a `where` reaches an array column

`findMany({ where: { tags: ['x', 'y'] } })` against `tags String[]` returned `[]`
for a row whose tags were exactly that. The bare array is litestone's shorthand
for `IN`, and `"tags" IN ('x','y')` asks a JSON document whether it equals `'x'`.
`$checkWhere` reported nothing — the key IS a real field — so `autoFilter` passed
it through as a valid filter. The one shape a caller reaches for first was the
one shape that silently answered nothing.

The shorthand now says the same thing on both kinds of column — **the column's
value is in this list** — and the SQL stays an `IN` either way:

```sql
-- { status: ['active','pending'] }   "status" IN (?, ?)
-- { tags:   ['x','y'] }              EXISTS (SELECT 1 FROM json_each("tags") WHERE value IN (?, ?))
```

A scalar has one value to test; an array column supplies its elements. On an
array column that is `hasSome`, reached without a new word.

**It is deliberately not `equals`, which is where Prisma reads it the other way.**
Both readings can be silently wrong for a caller who meant the other, but they
fail in opposite directions: `equals` fails to *zero rows*, the shorthand fails
to *too many*. A wrong empty result is the failure this change exists to remove,
so re-introducing one as the default reading would have been the wrong trade.

### What came with it

| | |
| --- | --- |
| `equals` | new. `json(col) = json(?)` on an array column, ordinary equality on a scalar. `json()` on both sides so a row a JS migration wrote as `[ "x", "y" ]` still matches |
| `hasNone` | new. The counterpart to `hasSome` |
| `not: [...]` | fell into `col != ?` with one placeholder and N bindings, so SQLite answered *expected 1 values, received 2* — about placeholder counts, naming neither the field nor the reason. Now NOT-equals on an array column, `NOT IN` on a scalar |
| `has`/`hasEvery`/`hasSome`/`isEmpty` on a scalar column | raised `malformed JSON` from `json_each`, naming neither the field nor the operator. Now refused by name |
| `{ tags: [] }` | emitted `IN ()`, which is not valid SQLite. Now matches nothing, like `in: []` |

`equals` and `not` compare the whole document and are therefore
**order-sensitive** — `['y','x']` does not match a row stored `['x','y']`. That
matches PostgreSQL array equality, and so Prisma's.

### The plumbing

`buildWhere` could not tell the two readings apart, because they are the same
shape: `{ id: [1,2] }` and `{ tags: ['x','y'] }` differ only in what the column
is. It now takes an `arrayFields` set for the model, built once by
`buildArrayMap` beside the bool and enum maps, and threaded to every path that
builds its own WHERE — `delete`, `deleteMany`, a relation filter (the TARGET
model's set), an `include` filter, and a `_count` include.

## 2026-08-11 — a set of enum values is a column

`targets ReclaimTarget[]` was refused at parse time, so a declared vocabulary of
MANY values had no home in the seed. An app wrote `String[]` and validated the
members somewhere else, or declared the enum anyway and kept two homes with
nothing joining them — which is how `AlertRule.severity` came to default to a
value its own API refused.

```prisma
enum ReclaimTarget { logs  cache  artifacts }

model ReclaimRule {
  id      Int @id
  targets ReclaimTarget[]
}
```

One declaration now feeds the column (JSON TEXT under the same
`json_type = 'array'` CHECK every array carries), the generated type
(`ReclaimTarget[]`), the JSON Schema and the picker. The `$ref` goes on the
**items** rather than the field — a picker reading the field's own schema would
otherwise offer one choice for a column that holds several. Every member is
checked on create and update, and the error names all of the bad ones.

**There is no membership CHECK and there cannot be.** Reading a JSON array's
elements needs `json_each`, that needs a subquery, and SQLite forbids a subquery
inside a CHECK. `enumCheck` returns null for an array rather than emitting
`IN (...)`, which would compare the whole document against one value and fail
every non-empty set. So the client is the boundary here, the same tier
`@minItems`, `@uniqueItems` and `Int[]` element typing already sit at.

### `@default` on an array field

`tags String[] @default("x")` parsed and migrated into a column whose own
default violates its own CHECK, then failed the first insert that relied on it
with `CHECK constraint failed` — naming the constraint, not the schema line.
A `@default` on an array field must now be a JSON array string; `@default("[]")`
still passes, `@default(a)` and `@default(1)` are schema errors.

## 2026-08-11 — a bulk write takes its columns from each row

`createMany` built one prepared statement from `Object.keys(rows[0])`, so row 0
decided what every other row was allowed to write:

```js
createMany({ data: [{ id: 1, title: 'a' },
                    { id: 2, title: 'b', subtitle: 'HELLO', views: 99 }] })
// → { count: 2 }, and row 2 has subtitle null, views 0. Nothing said.

createMany({ data: [{ id: 1, title: 'b', subtitle: 'HELLO', views: 99 },
                    { id: 2, title: 'a' }] })
// → SQLiteError: NOT NULL constraint failed: post.views
```

The same two rows, in the same call, either lost data or threw — on their order
alone, and one of the two was silent. A column absent from a later row was bound
as an explicit NULL, and that defeats the DDL `DEFAULT` that would have filled it.

Now one prepared statement per row SHAPE, cached by column list. A uniform batch
— the ordinary case — prepares exactly one and reports the SQL it always did.
Rows still insert in **caller order** rather than grouped by shape, because an
`@id @default(autoincrement())` is assigned in insert order and grouping would
renumber the caller's rows. `upsertMany` had the identical defect and is fixed
the same way, with the `ON CONFLICT DO UPDATE SET` clause derived per shape.

### A key set to `undefined` means absent

The same NULL bind hit one row with no batch involved: `{ views: form.views }`
off a form with no views field put a present-but-undefined key in the payload,
which became `views = NULL` and failed a NOT NULL column. `writeData` now drops
an undefined-valued key along with the unknown ones, so only `null` clears —
create, createMany and update alike.

## 2026-08-11 — `db` names main's path

`createClient({ db })` was consulted only to invent an implicit main when the
schema declared none. Against a schema that declares one it did nothing and said
nothing, so `db: ':memory:'` wrote the declared file and a test that believed it
was in-memory accumulated state across runs. basecamp carried a nine-line
comment warning about it instead of passing the option.

`db` now names main's path either way. Most specific wins:

| | |
| --- | --- |
| `databases: ':memory:'` | every SQLite database, plus a tmpdir per jsonl/logger one |
| `databases: { name: { path } }` | one named database |
| `db` | **main only** |
| `database main { path ... }` | the declaration |

It reaches main and nothing else — a second declared database keeps its declared
path, which is the whole distinction between the two options.

## 2026-08-11 — a migration only drops what litestone named

An index created outside the schema — in a JS migration, or straight against the
database — was live-and-not-pristine, which lands in `indexes.dropped`. Since
`hasChanges` counts that list, **its presence was itself the change**. Measured:

```
1 first autoMigrate    : in-sync
2 app adds an index    : ["note_title_idx"]
3 restart, same schema : in-sync   ["note_title_idx"]     ← survives
4 an UNRELATED nullable column added
                       : migrated  []                     ← gone
```

The DDL-hash fast path is what hides it. The index survives every restart until
someone makes an unrelated change, and dies with it. No error, no rebuild — a
query plan collapses and the app is only slower.

Every index litestone generates for a model table is `idx_<table>_<fields>`, so
the prefix is what it owns. Removing an `@@index` still drops `idx_note_title`;
`note_title_idx` is now left alone. An index the app happens to name
`idx_<table>_…` is still litestone's, since that is the name litestone would
generate for the same declaration.

**A rebuild is a separate matter and stays unsupported.** It drops the table,
which takes every trigger and index on it; litestone's own are regenerable and
restated, and the app's exist only in the live database. Rather than lose them
silently, the generated migration now names them before the SQL that destroys
them:

```sql
-- "note": this rebuild DROPS the table, which destroys:
--     trigger "note_audit"
--     index "note_title_idx"
-- Litestone did not create these and cannot restate them — recreate
-- them below, or in a JS migration that runs after this file.
```

`FJS-187` fixed; `FJS-183` ruled and left open to revisit. 4 tests,
mutation-checked.

### A `view` over a model made that model impossible to migrate

A rebuild ends in `ALTER TABLE "note__new" RENAME TO "note"`, and SQLite
reparses every view in the schema on a rename. A view still pointing at the
table the rebuild just dropped is an error:

```
model Note { id Int @id  title String  scratch String }
view NoteV { title String  @@sql("SELECT title FROM note") }

→ drop `scratch`
→ SQLiteError: error in view NoteV: no such table: main.note
```

Litestone's own `view` declaration against litestone's own migrations. Declare
one over a model and that model could never drop a column, change a type,
change a foreign key or change `@@strict` again — the migration failed
identically every time, naming the view rather than the cause. A hand-made view
did the same.

**A view is not in the trigger's class.** It is a stored `SELECT` with no state
and no side effects, so it can be dropped before the rebuild and put back
verbatim after, which is now what happens — schema-declared and app-created
alike. A view the schema redefines in the same migration is left to the
changed-views block instead, since restating its old body would fail on exactly
the change the new body was written for.

One sharp edge closes with it. SQLite does not resolve a view body at `CREATE`
time, so a view over a column the rebuild dropped comes back without complaint
and fails in whatever reads it. Each restored view is now read once inside the
migration's transaction, so a view the change invalidated refuses the migration
rather than surviving broken. That cannot catch a body written `SELECT
"scratch"` with the column double-quoted — SQLite resolves an unknown
double-quoted identifier as a string literal and reports nothing, the same trap
`rebuildSQL` already carries a comment about.

`FJS-188`. 6 tests, mutation-checked.

## 2026-08-11 — a `@computed` field may declare what it reads

`applyComputed` iterated the whole extension map and knew nothing about
`select`. Measured on a model with two computed fields:

```
findMany({ select: { id: true, title: true } })
→ both fns ran, over rows carrying only id and title, and both results
  were then thrown away by trimToSelect
```

The waste is the smaller half. The row those fns received was the one the select
had already narrowed, so a fn reading an unselected column saw `undefined` and
answered something plausible. That is the third appearance of one failure: the
same shape was chased across `findManyCursor` and all three `include` shapes,
and again across a relation `orderBy`, both times as a missing `@from` field.
Here the select path itself was the narrowing.

A computed field outside the caller's select is no longer computed. That removes
the waste and the partial row together — there is no path left on which a fn
runs over a row shaped by a select that did not ask for it.

The other half is the fetch. Selecting a computed field set `needsAllDbCols`, so
the SQL widened to `SELECT *`, which defeats a covering index, decrypts
`@encrypted` columns nobody asked for, and emits **every** `@from` correlated
subquery on the model — the `*` branch is what appends them, so three `@from`
fields cost three subqueries per row for a computed field needing none.

A fn may now declare its inputs:

```js
export default {
  Client: {
    chattiness: { needs: ['noteCount'], compute: row => row.noteCount * 2 },
  },
}
```

The SELECT carries exactly those names, a `@from` among them emits just that
subquery, and all of them are trimmed from the result — asking for a computed
field does not smuggle its inputs back. A bare fn keeps the old behaviour and
the old `*`, because undeclared has to mean *fetch everything*; one bare fn in a
select widens it for the declared ones too.

**The declaration is enforced rather than trusted.** The row a declared fn
receives carries exactly the declared names and reading anything else throws,
naming the field and the list. Without that, adding a line to the fn and
forgetting the list would answer `undefined` — strictly worse than fetching
every column, and the same silence the first half of this change exists to end.
`in` is left alone, so feature-detection still works. A `needs` naming something
that is not a readable field of the model is refused at `createClient`, where
the list is written, rather than at a read that would answer nothing.

Narrowing reaches `findManyCursor` and `search()`, which build their own
SELECTs, and a nested `select` under an `include`.

`FJS-184`, `FJS-185`. 16 tests, mutation-checked.

### Found by it: `search()` dropped every row when the select omitted the id

`search()` runs two queries — the FTS5 table for `rowid` + `rank`, then the base
table for the rows, rejoined by id to restore rank order. The second took the
caller's `select` verbatim, so:

```
db.message.search('sqlite', { select: { title: true } })   → []
```

No error, no partial answer: *no results* for a query that has them, and the
more precisely a caller asked the more completely it failed. Pre-existing and
unrelated to the change above, but found by it — narrowing a computed field's
fetch is what makes an id-less select common rather than rare. The id is now
injected when a narrowed select omits it, and dropped again by the trim.

`FJS-186`. 3 tests.

## 2026-08-11 — `@@softDelete` + `@@fts` corrupted the index on every soft delete

Found while splitting a test fixture in two to avoid it. The pair was unusable:

```
db.note.remove({ where: { id: 1 } })
→ SQLiteError: database disk image is malformed   (SQLITE_CORRUPT_VTAB)
```

Two triggers fired on one soft delete. An unconditional `AFTER UPDATE` one
issued `'delete' old` and re-inserted `new`; an `AFTER UPDATE OF "deletedAt"`
one issued `'delete' old` a second time. FTS5 reports a repeated delete of one
docid as a malformed database — a message naming neither the model, the FTS
table, nor the two attributes that could not both be declared, so it read as a
broken file rather than an unsupported combination.

**It only raises when the extra delete empties the structure.** With more than
one indexed row the second delete was swallowed and the row stayed in the index,
which is why nothing caught this and why the original report said *every*
`remove()` throws. So the triggers never achieved the live-only index they were
written for either: `search()` was correct only because it filters again in its
own `WHERE`.

That second filter is now the only one. The index mirrors the table, the two
extra triggers are retired, and the trigger set no longer branches on
`@@softDelete` at all — one owner for "is this row visible", which is the rule
the rest of the package already follows.

Three things follow from it:

- **`withDeleted` / `onlyDeleted` on `search()` work.** They were documented and
  accepted, and could not do anything: the rows they asked for were not in the
  index to find.
- **`rebuild` agrees with the triggers.** It reindexes straight from the content
  table, so it can only match an index that mirrors that table. A live-only
  index silently disagreed with its own rebuild.
- **`search()` narrows before the FTS `LIMIT`.** Soft-deleted, template and
  `where`-excluded rows used to spend slots that step 2 then discarded, so a
  search for 20 answered 13 with nothing to say why, and `offset` paged index
  entries rather than matching rows.

The fixture that found this now carries both attributes on one model. Two
fixtures, each exercising one attribute, is exactly what hid it.

## 2026-08-11 — a trigger could never migrate, and a rebuild destroyed every one

Both found fixing the above, and both are why that fix would otherwise have
reached new databases only.

**`introspect()` recorded no triggers.** Tables, columns, indexes, foreign keys,
STRICT and views were all read back; triggers were not. So `diffSchemas` could
not see one and `generateMigrationSQL` could not emit one — every database that
already existed kept the broken trigger pair while the diff reported the schema
in sync. Triggers now travel in `__triggers` beside `__views` and compare on
normalised SQL.

**A table rebuild dropped every trigger and put none of them back.**
`rebuildSQL` is the standard SQLite rewrite — create `_tmp`, copy, `DROP TABLE`,
rename — and dropping the table takes its triggers with it. A model came out of
an ordinary column-drop migration with an FTS index that had stopped updating
and an `updatedAt` that had stopped being stamped. Writes still succeed and
searches still return rows, so there is nothing to notice. A rebuilt table now
has its generated triggers restated afterwards.

Only names Litestone generates are ever dropped — `*_fts_*`, `*_updatedAt`. A
trigger the app wrote is not in pristine, so nothing here drops it. It is still
lost by a rebuild, which is `FJS-183` and stated in `docs/migrations.md` rather
than fixed silently.

## 2026-08-11 — `@from` read the target model the wrong way, twice; `orderBy` validated nothing

Three defects found in one sitting, by trying to build a CRM "chattiness" score:
a per-client count of notes, messages and call logs, divided by the account's
age. That is `@from` for the counts and `@computed` for the ratio, which is the
shape the package already recommends, and all three of these were on the path.

**A `@from` ignored the target model's own defaults.** `@from(Note, count: true)`
counted soft-deleted rows and template rows. Every schema therefore had to write
`where: "deletedAt IS NULL"` by hand on every derived field — a default nobody
remembers on the second model, and one that goes silently wrong rather than
loudly. `include: { _count: true }` over the same relation had injected both
filters since it was written, so the two counts of one relation disagreed:

```prisma
model Client {
  noteCount Int @from(Note, count: true)   // counted deleted notes
  notes     Note[]
}
// db.client.findMany({ include: { _count: true } })  → _count.notes excluded them
```

A `@from` now reads the target the way the target is read. `withDeleted: true`
and `withTemplates: true` opt back in, named for the `findMany` args rather than
inventing a second vocabulary, and an explicit `where:` still composes on top.
An existing `where: "deletedAt IS NULL"` becomes redundant, not wrong.

**A `@from` did not survive a relation `orderBy`.** The correlated subquery names
the outer table, and a relation orderBy aliases that table to `t`, so the two
disagreed — in two different registers depending on what the caller selected:

```js
db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
// → every @from field undefined, and a @computed field reading one
//   computed from undefined, in silence

db.author.findMany({ orderBy: { books: { _count: 'desc' } }, select: { bookCount: true } })
// → SQLiteError: no such column: author.id
```

Both variants of every subquery are built at schema load now, and the query
picks by whether it aliased. The WHERE clause needs the same choice, and the
alias question is not the join question — a relation *aggregate* orderBy adds an
order part and no join, which is the case that was still wrong after the SELECT
list was fixed.

**`orderBy` validated nothing at all.** `orderBy: { bogusColumn: 'desc' }` was a
silent no-op: rows came back in insertion order, no warning anywhere, not even
the stderr line that `where` prints. The same silence covered `@computed`, which
cannot be sorted at all — it is a JS function over a row, so SQLite can neither
sort nor paginate by it — so a list "sorted by" a derived score was ordinary
rows in arbitrary order, and page 2 of it was plausible and wrong.

This half does **not** inherit `checkWhereKeys`'s warn-on-read split. A bad
filter key returns fewer rows, which the caller can see; a bad sort key returns
the right rows in the wrong order, which nothing can see. Both now throw, naming
what is sortable, and separating the two refusals — a field that does not exist
gets a typo suggestion, a `@computed` field is told why it cannot be sorted and
what to do instead. A `@from` field sorts, as it always did.

`db.$checkOrderBy(accessor, orderBy)` is `$checkWhere`'s sibling and carries the
identical contract: ask before you query, an unknown accessor answers `[]`
because *I cannot judge this* is not *this is wrong*, and every flavour of client
answers identically, because sortability is a fact about the schema that auth and
scope cannot change. Junction's `autoSort` calls it and answers 400.

**And `@from` turned out to exist on one read path only.** `findManyCursor` and
`resolveIncludes` build their own SQL below the query pipeline, so neither ever
appended the subqueries — the field was absent, not wrong:

```js
await db.author.findMany()                            // { id, name, bookCount: 2, score: 10 }
await db.author.findManyCursor({ limit: 10 })         // { id, name,               score: 0  }
await db.book.findMany({ include: { author: true } }) // author: { id, name,       score: 0  }
```

Absence is the dangerous half. `applyComputed` runs either way, so a `@computed`
field over a missing `@from` field answered a plausible `0` rather than throwing
— the same row read two ways gave two different numbers, and neither complained.
Selecting the field by name on those paths answered `{}`.

Closed the way `@from` under an alias was: `fromSelectExpr()` and
`deserializeFromRow()` are module-level, `fromMap` is on `ctx`, and the four
sites ask instead of growing a fourth copy of the rule. The m2m include needed
the aliased variant, since it selects `t.*` beside the join table. Both halves of
the shaping were missing and only one of them is visible — without the SELECT
expression the field is absent, without the deserializer a `@from(X, last: true)`
arrives as the JSON string SQLite returned.

Walking every method that returns a row found two more of the same, and they
are closed too. `search()` builds its own step-2 SELECT. And **every write
returned a row with no `@from` field at all** — `RETURNING` is table columns
only, SQLite cannot put a correlated subquery there:

```js
await db.author.findUnique({ where: { id: 1 } })      // { …, bookCount: 2, score: 10 }
await db.author.update({ where: { id: 1 }, data: {} }) // { …,               score: 0  }
```

That is the one that reached furthest. Junction returns `table.update()`
straight through, so the PATCH response *and* the `svc updated` broadcast built
from it both carried the degraded row — every open tab replaced a correct row
with it.

Writes now re-read the `@from` values before shaping. One extra SELECT, only
for a model that declares `@from`, and only on write paths that opt in — a read
already carries the values, and hydrating whenever a key happened to be missing
would fire a query per row for a `select` that legitimately excluded them.
`delete` needs no extra query: it already reads the row before the DELETE, which
is the only moment the values still correlate to anything.

## 2026-08-11 — `restore()` answers the rows

It returned `{ count }`. `index.d.ts` declared `Promise<TRow | null>` and
`CLAUDE.md` documented `row[]`; three sources, three answers, and the
declaration was the wrong one in the direction that typechecks —
`(await restore(…)).id` compiled and was `undefined`.

The rows were there the whole time: `restore` runs `UPDATE … RETURNING *` and
threw them away to count them. It now answers the array, which is what `where`
matching many implies and what `remove` already does with its row. They are
also **shaped** — the RETURNING rows had never been through `read()`, so had
they been returned before they would have carried unparsed Json, `0`/`1` for
booleans, and no computed or `@from` fields.

Breaking for a caller reading `.count`. One existed: this package's own
audit-trail suite.

64 tests, mutation-checked — 45 fail on revert. Proven by `example`: `verify`
(37) and `verify:jobs` (8), `basecamp`: `verify` (270), `sierra`: `test:safety`.

## 2026-08-10 — an `include` enforced nothing the model declared

Every access rule in the package held on a direct read and none of them survived
being reached as somebody's child:

```js
await db.$setAuth(u).vault.findMany()
// AccessDeniedError: "Vault.read" requires level 7, user has level 4

await db.$setAuth(u).team.findMany({ include: { secrets: true } })
// → every Vault row, @guarded(all) columns in plaintext
```

Four rules, one hole. `@@gate` never fired, because it fires in `onBeforeRead`
for the model being addressed. `@@allow`/`@@deny` never filtered, so a tenant
scoped out of a row still received it as a parent's child. `@guarded` and a
field `@allow` were never applied, and `@encrypted` came back as raw ciphertext
— which also meant `asSystem()` did **not** decrypt it, the same bug pointing
the other way.

The cause is one shape: `resolveIncludes()` builds its own SQL and bypasses the
query pipeline for speed, which is why the soft-delete and `@@hasTemplates`
filters in it are hand-appended. Nothing hand-appended the access rules. No test
in 1462 asked a policy question through an include, and the docs promise the
opposite in as many words — *there is no path to unfiltered data except
`asSystem()`*.

Three owners, because the three rules answer at different times:

- **The gate is a preflight**, in `GatePlugin.onBeforeRead`, walking `include:`,
  `select:` and `_count` down the tree. It has to be a preflight rather than a
  filter: `getLevel` is async and the include resolver is not. It also has to
  **refuse** rather than return nothing — a gate is per model, so an empty list
  would read as *no rows* instead of *not for you*. The nested-WRITE preflight
  beside it has done exactly this since gates existed; reads were the direction
  nobody mirrored.
- **The row policy is compiled in**, into all three relation SQL shapes and both
  `_count` shapes. The m2m branch takes it as a subquery over the target alone,
  because there the target is aliased `t` beside the join table and the policy
  compiler emits unqualified column names.
- **The field rules moved out of the closure.** `applyFieldPolicyTo(row,
  modelName, …)` is now module level, so a path holding rows of a model that is
  not its own can ask for them — one definition instead of the two that drifted.

13 tests, mutation-checked: 10 fail on revert, 3 are controls. 1480 pass. Found
by declaring `@@allow` on one model of `basecamp`'s 37 and asking what would
have to be audited first — the answer was the `include` graph, and the graph
turned out not to matter, because nothing in it was enforced.

## 2026-08-10 — implicit many-to-many only ever worked on `Int @id` named `id`

```
model Post { slug String @id  tags Tag[] }
model Tag  { code String @id  posts Post[] }
```

The join table came out as `"postId" INTEGER NOT NULL REFERENCES "post"("id")`
whatever the models said. Two shapes, two different failures.

**A uuid key failed loudly**, which is the better half: STRICT refuses the TEXT
and the first `connect` dies with `cannot store TEXT value in INTEGER column
_post_tag.postId` — an error naming a table the author never wrote.

**A key named anything else failed silently.** Join rows are written `INSERT OR
IGNORE`, so connecting twice is idempotent — and OR IGNORE swallows a NOT NULL
violation exactly as happily as a duplicate. `.id` on a row keyed by `code` is
`undefined`, so `connect` returned the created row, wrote nothing, and the
relation read back empty. Forever.

The fix is one fact carried instead of assumed: `detectM2MPairs` now puts each
side's `@id` **name and SQL type** on the pair, and the relation map carries
`selfPk` / `targetPk` to the six runtime sites that each had their own `t."id"`
— the include join and its policy subquery, `_count` in both directions, the
relation-filter correlation, the aggregate `orderBy`, and the
connect/disconnect/set/delete writes. The `@edge` side table had copied the same
two DDL lines and takes the same treatment. A target row with no key now throws
by name rather than being ignored.

Nothing here caught it because nothing here uses the feature: `basecamp` writes
an explicit join model all three times it needs one, and `sierra/example` is the
only implicit m2m in the repo — keyed `Int @id`. 4 tests, mutation-checked in
both halves.

**Upgrading an existing database**: join tables are invisible to introspection
(underscore prefix), so a migration emits them `IF NOT EXISTS` and never alters
one. A database created before this keeps its `INTEGER` table and the same
failure. Drop it and re-run the migration — it is provably empty, since no
insert into it could ever have succeeded on the schemas this affected.

## 2026-08-10 — a refused update stayed applied

`@@allow('post-update', …)` is the rule that catches a write which was legal
when it started and illegal once it landed — moving a row out from under its
owner. It rolled the write back by writing the before-snapshot's columns back
one by one, and that snapshot came from `read()`, where a Json column is an
object. A SQLite parameter cannot be an object:

```
TypeError: Binding expected string, TypedArray, boolean, number, bigint or null
```

Two failures out of one line. The `AccessDeniedError` never reached the caller —
a binding error did, naming nothing they had written — and **the update the
policy had just refused was left in the database**, because the throw happened
before the revert.

`read()` was the wrong snapshot for the job in two further ways: it adds
computed and `@from` fields that no `UPDATE` can name, and it strips `@guarded`
ones. The rollback now reverts from the raw row, whose keys are the table's
columns exactly. `beforeRow` stays read-shaped, for the audit snapshot that
wanted it that way.

It surfaced the first time a model with Json columns declared a policy —
`basecamp`'s `Server`, where *move this server into another workspace* is the
exact thing post-update is there to refuse.

## 2026-08-10 — a transaction dropped the scope it was started from

`db.asSystem().$transaction(tx => tx.account.create(…))` was refused by the
`@@gate` it was meant to bypass. The callback received the **root** client:
every scoped proxy — `asSystem()`, `$setAuth(u)`, `$scopedBy()` — exposed the
root `$transaction`, which hands `fn` the unscoped `clientProxy`.

It fails in opposite directions on the two flavours, and only one of them is
loud. As system, the body is refused by a level it should never have been asked
about. As a user, nothing throws at all: `auth()` is null inside the
transaction, so every `@@allow` matches nothing and every `@createdBy` stamps
nobody — which reads as a bug in the transaction body.

Each proxy now passes ITSELF; the root is unchanged. The `query()` batcher on
those same proxies already did this and carried a comment explaining why —
`$transaction` was the one that did not.

Nothing had noticed because no schema in the repo carried both a transaction and
a gate until `basecamp` declared its levels. Its first-run `POST /setup` writes
four models in one transaction as system, and failed on the very first request
of the drive with *"Account.create" requires SYSTEM access (use asSystem())* —
about a call that was using `asSystem()`. 3 tests, including the quiet policy
case; 1461 pass.

## 2026-08-07 — raw SQL could not write, and had never been able to

`db.asSystem().sql` is the documented — and on any schema declaring access
rules, the *only* — way to run a raw statement. **Every raw write through it
failed**, with `SQLITE_READONLY: attempt to write a readonly database`: a
message about a connection, naming nothing the caller wrote.

`_runRawSql` sent every statement to `readDb`, which is opened `readonly` with
`query_only = ON`. That is right for `SELECT` and wrong for everything else, and
the three surfaces that call it (`db.sql`, `db.$setAuth(u).sql`,
`db.asSystem().sql`) all inherited it — as did **the system client a JS
migration is handed**, which is exactly the caller most likely to need a raw
`ALTER`/`UPDATE` and least able to route around it.

Statements now route by kind: `SELECT`/`EXPLAIN`/`VALUES` stay on the reader,
everything else goes to the writer, which reads perfectly well. `WITH` counts as
"everything else" on purpose — `WITH x AS (…) DELETE FROM …` is legal SQLite, so
a CTE cannot be assumed to be a read. Leading comments are stripped before the
test, so `-- why\nDELETE …` is not misread as an unrecognised statement.

Found in `basecamp`, hard-deleting a row to prove an FK cascade fires — the one
thing `.remove()` cannot do on a `@@softDelete` model. 3 tests; 1454 pass.

## 2026-08-07 — `docs/jsonschema.md`, and `--stdout` that actually pipes

The JSON Schema this package generates is the wire the other two realms are
built on, and **nothing documented what it emits.** `x-messages`, `x-relations`,
`x-gate`, `x-transitions` and `x-version` were described in the repo's bridge
index because a consumer needed them; the other eight extensions were not
described anywhere. `docs/jsonschema.md` is now the full reference — every
standard keyword, every `x-`, which mode and audience produces it, and **who
reads it**. That last column is the useful one: `x-litestone-policies`,
`x-litestone-read-policy`, `x-litestone-from`, `x-litestone-secret` and
`x-litestone-guarded` are emitted and read by nothing at all.

Every snippet in it was generated, not written. The fixture that produced them
is at the foot of the doc, because no app in the repo exercises the whole
surface — `example` has no `File`, `Bytes`, `@from` or `@version` field, and
`basecamp` declares no `@@gate`.

Two things the writing found:

**`litestone jsonschema --stdout > schema.json` produced invalid JSON.** The
banner is printed with `console.log`, so `litestone jsonschema` landed at the
top of the file being piped. `litestone types --stdout` had it too, writing the
banner into the `.d.ts`. Both now suppress the header when `--stdout` is set.

**`--include-computed` did nothing.** The CLI read the flag and passed
`includeComputed` through; `generateJsonSchema` never destructured it. Derived
fields are governed by `mode: 'full'` alone, so the flag was removed rather than
implemented — the mode already means "everything readable". It is gone from the
CLI help and from this package's `CLAUDE.md`, which had also listed it.

## 2026-08-06 — `$checkWhere` on every client, not just the root one

1451 tests (was 1450). `FJS-117`.

It was written **inline in the top-level proxy's `get` trap**, so the three
derived clients — `$setAuth`, `asSystem`, `$scopedBy` — did not have it. And a
Litestone proxy *throws* on an unknown property rather than answering
`undefined`, on purpose, so a typo'd accessor is loud:

```js
db.$checkWhere                    // → function
db.$setAuth(user).$checkWhere     // → Error: "$checkWhere" is not a table in this schema
```

Junction hands a service the `$setAuth` client on `ctx.locals.db`, so its
`autoFilter` hook could not even *ask whether* the method existed without
throwing. **Every list read by a signed-in caller 500'd, in both apps**, naming a
table nobody had written.

It is now one function in `createClient` scope, handed to all four proxies and
pinned to give identical answers on each. Which keys are filterable is a fact
about the **schema**; auth and scope have no bearing on it, so there was never a
reason for the root client to be the only one that could say.

The shape of the mistake is worth more than the fix. Every test that touched
`$checkWhere` held the root client, so 1450 of them passed over a seam no real
request uses — and the browser symptom was **navigation**, not data: the page
committed the redirect and then threw while fetching, which read as a router
bug and was blamed on an unrelated change to another package.

## 2026-08-06 — `$checkWhere`: ask before you query

1450 tests (was 1443). The litestone half of `FJS-109`.

The ORM validates where-keys already, and the read/write split is deliberate: a
typo'd filter on a **write** is a mis-scoped destructive operation and throws,
while on a **read** it warns and returns nothing. That is right for a caller
holding the client. It is wrong one layer up, where the warning goes to the
server's stderr and the HTTP caller gets `200 {"data":[],"total":0}` — a typo, a
misplaced directive and an empty table wearing the same answer.

Rather than let Junction grow a second definition of "is this a valid filter
key" against JSON Schema — which would drift from this one on relation
sub-filters, `$raw`, edges and the AND/OR/NOT descent — the client now answers
the question:

```js
db.$checkWhere('product', { nme: 'a' })
// → [{ key: 'nme', suggestion: 'name', allowed: ['id','name','price'] }]
```

Same rule, same Levenshtein hint, same descent, but it neither warns nor runs a
query — pinned by a test that taps `$tapQuery` and `console.warn` and asserts
both stay empty. An unknown accessor returns `[]` rather than throwing: a caller
using this to reject a request must not reject what it failed to understand.

Nothing about the ORM's own behaviour changed. `findMany` still warns, writes
still throw.

## 2026-08-06 — the benchmark harness works again

No test change. `bun run bench` and `bun run bench:core` now exist; `FJS-112`
filed.

`bench/audit-bench.mjs` had not been run since the 2026-07-18 audit produced it,
and it had a broken case:

```
gate-getlevel FAILED: "posts" is not a table in this schema. Tables: post
```

A plural accessor against `model Post`. So the one measurement that proves the H4
fix — GatePlugin resolving `getLevel` once per scoped client rather than once per
operation, a cache with security-relevant behaviour behind it — had been silently
skipping for three weeks. It reports **0 calls across 200 gated reads**, which is
the pass condition.

Several annotations were fossils: they described the pre-fix behaviour of findings
fixed the same day, so a reader saw `0.3 ms/call` beside *"runs full pristine build
+ 2x introspection"*. Each now names the finding it verifies, or says **STILL
OPEN** — one does: JSONL `create()` is still `existsSync` + `statSync` +
`appendFileSync` per row, confirmed against `drivers/jsonl.js`.

Every fix from the audit still holds, re-verified rather than assumed —
`upsert()` issues ONE statement, checked with `$tapQuery` instead of inferred
from the timing.

**On reading the numbers:** a first pass looked ~2x worse than the audit on the
core path. It was not. Interleaving the same bench against the pre-session tree,
four rounds on one machine, put run-to-run spread wider than the delta, and a
later quiet run landed at 1.65 / 38.9 / 10.5 µs (`findUnique` / `findMany` 100 /
`create`) against the audited 1.28 / 38.4 / 9.2. Absolute µs across machines mean
nothing here; only an interleaved same-machine A/B does.

Also measured, since nobody had it: `@@createdBy` + `@@updatedBy` costs +21% on
create and +28% on update (partly two real FK columns, not only the stamp), and
`@version` +7% create / +35% update.

## 2026-08-06 — the client enumerates, and `asSystem()` stops lying

1443 tests (was 1437). Closes `FJS-014`, open since 2026-08-02.

`Object.keys(db)` threw. So did `Object.getOwnPropertyNames(db)`, `{...db}`,
`for…in`, and — the one that actually hurt — `JSON.stringify(db)`, which meant
logging a context blew up on a line that was not the bug.

The cause was two strings. `$setAuth` and `$db` were on the proxy target *and*
in the `ownKeys` trap's hand-written list, and a duplicate makes the **engine**
throw:

```
TypeError: Proxy handler's 'ownKeys' trap result must not contain
           any duplicate names
```

which names proxy internals and neither of the two responsible. All five traps
now go through one `dedupeKeys()` rather than having the two names deleted — the
literal lists have grown before, and the next property added to a target would
reintroduce it with no test able to predict which one.

### The quieter half, found by probing rather than by the report

`asSystem()`'s proxy had a `get` trap **and nothing else**. So it did not throw;
it answered wrongly:

```js
db.asSystem().user            // works
'user' in db.asSystem()       // false
Object.keys(db.asSystem())    // no tables at all
```

A guard reading `if ('user' in db)` silently skipped the table under a system
client — a wrong answer rather than a loud one, which is the worse of the two.
It now carries the same `ownKeys` / `has` / `getOwnPropertyDescriptor` traps as
every other scoped client.

### What it cost downstream

Junction wrapped its own `Object.keys(db)` in a `try/catch` with a ten-line
comment, because otherwise this replaced a *"your model name is wrong"*
diagnostic with a stack trace about proxies. The catch stays — `db` is whatever
the app handed to `createApp` — but the comment no longer describes a live bug,
and the list turned out to be wrong the moment it started working: it offered
`asSystem`, `sql` and `query` as model names. Junction now filters against
`$schema.models`.

Worth noting how it survived four days: every test of that message used a plain
object as the client, so the one path that mattered — a real Proxy — was the one
nothing exercised. There is now a test on each side, and junction's uses a real
Litestone client.

## 2026-08-06 — `@version`: the lost update is now a 409

1437 tests (was 1416). `IDEAS/declared-semantics.md` item 1, shipped.

Nothing in litestone carried a row version, so two people editing one order both
`PATCH`, both succeed, and the second silently erases the first — the oldest
silent-wrong-data bug there is.

```js
const alice = await db.order.findUnique({ where: { id: 1 } })   // version 1
const bob   = await db.order.findUnique({ where: { id: 1 } })   // version 1

await db.order.update({ where: {id:1}, data: { status: 'paid', version: alice.version } })
// → { status: 'paid', version: 2 }
await db.order.update({ where: {id:1}, data: { status: 'void', version: bob.version } })
// → VersionConflictError: expected 1, row is at 2
```

### The mechanism already existed

`@@transitions` has run a compare-and-swap since 2026-08-04:
`applyTransitionWhereClause` narrows the `WHERE` by the value it read, and no
rows changed means somebody got there first. `@version` is that with the column
unfrozen — the same *generalise the mechanism rather than add a second one* move
`cascading-fields.md` argues for `@@softDelete(cascade)`. The bump rides the
`SET`, which also means a versioned update always has a column to write.

### Where it applies, and where insisting would be wrong

| Path | Requires | Bumps |
| --- | --- | --- |
| `create` / `createMany` | — | starts at **1**, whatever the payload says |
| `update` | **yes** | ✓ |
| `updateMany` | no | ✓ |
| `upsert` / `upsertMany` | no | ✓ |

`update` is the concurrent-editor path. A bulk `where` matches many rows and so
many versions — there is no single value to compare — and an upsert is reached by
natural key from a sync or an import, which cannot have read one. **Both still
bump**, which is the half that matters: without it a bulk write would leave every
open editor's version looking current. Pinned by a test.

The `upsertMany` trap was worth catching: taking the version from `excluded`
would reset a live row to 1 and make every stale editor current again. It is
`"version" = "order"."version" + 1` instead.

### Two errors, because they mean different things

`VersionRequiredError` is **400, not retryable** — you left out an input, and the
identical request fails identically. `VersionConflictError` is **409 + retryable**
— re-read and re-apply is a real strategy. Both carry `status`, so Junction maps
them with no registration (verified: → `Conflict` 409 / `BadRequest` 400). Not-found
still returns `null`; a 409 means the row is there and moved.

### The rest of the surface

`asSystem()` skips the check and still bumps — a migration or a job is not a
second editor, the same reason it skips gates. The version travels in `data`
rather than `where`, because a Resource fetch carries every column and a form
round-trips it with no plumbing. It reaches the client as `readOnly` in the
update schema plus **`x-version`** naming the column, is absent from the create
schema, and typegen drops it from `*Create` and makes it **required** in
`*Update` — the type saying what the runtime does. One per model, `Int`, not
optional, not the `@id`; all four are schema errors.

**The client half landed the same day** — `createResource` remembers the version
of every record it reads and puts it on the next patch, so an app writes nothing.
See sierra's `CHANGES.md` (`FJS-105`).

## 2026-08-06 — the bulk write paths run the `ctx.auth` stamps

1416 tests (was 1408). Closes `FJS-092`, which was filed too narrow.

`upsertMany` stamped nothing from `ctx.auth` — not `@default(auth().id)`, not
`@createdBy`, not `@updatedBy`. Probing the whole table rather than the one
filed method turned up a second hole:

| Path | `@updatedAt` | `@updatedBy` | `@createdBy` / `@default(auth().id)` |
| --- | --- | --- | --- |
| `create` / `createMany` | ✓ | — | ✓ |
| `update` | ✓ | ✓ | n/a |
| `updateMany` | ✓ | **✗** | n/a |
| `upsertMany` | ✓ | **✗** | **✗** |

**`updateMany` was the worse of the two, and it wrote a wrong name rather than
no name.** `@updatedAt` is a SQL trigger (`ddl.js`), so the timestamp half of the
pair kept working on every path while the identity half — which needs `ctx.auth`,
which SQLite does not have — silently did not:

```js
await asBob.doc.update(…)       // updatedById: 2   ← Bob
await asAnn.doc.updateMany(…)   // updatedById: 2   ← still Bob, timestamp moved
```

A row reading *edited four seconds ago by Bob* when Ann edited it is worse than
a null: null says unknown, a stale name says something false in an audit shape.

### A conflict is an update

`upsertMany` needed more than a stamp call. `updateCols` defaults to every column
that is not the conflict target, so simply filling `createdById` would have put it
in the `ON CONFLICT … SET` clause and made every bulk upsert rewrite the original
author. Create-time columns are now held out of that clause — **but only the ones
we filled**. A column the caller supplied stays in, because naming it is an
explicit request and excluding it would change behaviour that predates the
stamps; an explicit `update: ['createdById']` moves it too.

### One owner for "ctx.auth → column"

The stamp was inline in four places with two different meanings mixed between
them. Now two functions, named for the distinction:

- `stampFromAuth` — the **principal wins**. `@createdBy`, `@updatedBy`.
- `applyAuthDefaults` — the **payload wins**. `@default(auth().field)`, which is
  a default and documented as one.

Neither fires without `ctx.auth`, which is what keeps `asSystem()` seeders,
imports and backfills able to carry an explicit author in.

8 tests; **4 fail if the stamps are removed.**

## 2026-08-06 — raw SQL goes through `asSystem()` when the schema declares access rules

1408 tests (was 1399).

`db.sql` reads the base table: no `@@gate`, no `@@allow`, no `@guarded`, no
`@scoped`, no `@@softDelete` — they are all enforced above SQLite. For a
deliberate escape hatch that is defensible. What was not is that it was the
**same function on every proxy**. `authSql` closed over `user` and never read
it, so it was byte-identical to the unscoped `sql` — while `authQuery`, directly
beneath it in the same closure, goes to real trouble to keep that same auth
context alive through `$transaction`. One preserved the scope; one silently
dropped it.

Measured on one model with `@@allow` + `@guarded` + `@@softDelete`:

```
$setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
$setAuth({id:1}).sql`SELECT * …`      → 3 rows, ssn in plaintext, another
                                         owner's row and a soft-deleted one
```

### The unscoped client was the wider gap

An unauthenticated `db.invoice.findMany()` returns **0** rows — the policy
evaluates with `auth() == null` and matches nothing — while `db.sql` returned
all 3. So this was never "the scoped proxy drops its scope". Raw SQL ignored the
schema on *every* path and the ORM never does, and the anonymous path is where
the two disagree most. `IDEAS/scoped-sql.md` argued `db.sql` should be left
unchanged on the grounds that there is no identity to scope by; that is
overturned.

### The rule

| Surface | Schema declares access rules | It does not |
| --- | --- | --- |
| `db.sql` | **throws** | unchanged |
| `db.$setAuth(u).sql` | **throws** | unchanged |
| `db.asSystem().sql` | works — the documented bypass | works |

"Access rules" is `@@gate`, `@@allow`/`@@deny`, `@guarded`, `@encrypted`/
`@secret`, field `@allow`, `@scoped`. **Not** `@omit` or `@@softDelete` — those
shape what a read returns rather than who may read it, and refusing raw SQL for
a soft-delete column would fire on most schemas for a lifecycle rule.

### Coarse per schema, not per statement — on purpose

Deciding per statement means parsing the statement, and a hand-written SQL
validator that is subtly wrong grants a **false** guarantee, which is worse than
an honest raw hatch because people trust it. The escape routes are numerous and
all real: `main.`/`temp.` qualification, `ATTACH` (which this client exposes on
the proxy), `PRAGMA`, views created mid-statement, comment and string-literal
tricks. SQLite's own authorizer would be the right mechanism and **`bun:sqlite`
does not expose it** — verified, `Database` has no `setAuthorizer`.

### The refusal names both ways forward

`asSystem().sql` to bypass deliberately, or stay on the ORM — and for an
expression the query builder cannot express, `where: { $raw: sql\`…\` }` keeps
every policy. Verified rather than assumed: through `$raw` a scoped caller still
gets 1 row with the `@guarded` column withheld.

Also: three byte-identical copies of the raw runner (`sql`, `sysSql`, `authSql`)
collapsed to one.

9 tests; **5 fail if the refusal is removed**. The first caller it caught was
this package's own `@encrypted: stored as ciphertext in DB`, which peeked at a
raw column with `db.sql` — a genuine bypass, now saying so. Ruled in
`DECISIONS.md` § Access control. **Scoped raw SQL — the per-identity view set in
`IDEAS/scoped-sql.md` — is deliberately not built**; revisit with `herald`.

## 2026-08-06 — the audit log can record a String actor

1399 tests (was 1396).

The synthetic audit model declared `actorId Int`, and the jsonl driver's
companion index is a STRICT table. So the first audited write with a known actor
threw

```
SQLiteError: cannot store TEXT value in INTEGER column auditLogs_idx.actorId
```

and took the request with it. **Every FrontierJS app is exposed**:
`@frontierjs/auth` issues `id String @id @default(uuid())`, so its users are
uuids, and `@@log(audit)` on any model then fails on its first write by a
signed-in caller.

It was invisible until the same afternoon, and for a precise reason: Junction
handed the Data boundary a principal with no `id` at all, so `actorId` was always
null — and NULL fits an INTEGER column. Fixing that (junction's
`toDataPrincipal`) uncovered this. Two defects, one masking the other.

`actorId` is now `Any` — a real SQLite STRICT column type, and the honest one:
the trail records whoever the host app keys its users by, which is an Int in one
app and a uuid in another. The `.jsonl` itself was always untyped JSON.

**An existing index is rebuilt, not abandoned.** `CREATE TABLE IF NOT EXISTS`
does nothing to a table that already exists, so an index built before the type
changed would keep the old column and keep failing against a schema that no
longer explains it. The driver now compares the declared column types against
`pragma_table_info`, drops the table when they disagree, and **refills it from
the `.jsonl`** — which has every line and every byte offset. Dropping without
refilling would have been worse than the error: an audit trail that silently
looks shorter.

Found by `example/`, whose orders and customers are `@@log(audit)` and whose
users are auth's uuids.


## 2026-08-06 — `@encrypted` works on a `Json` field instead of destroying it

1396 tests (was 1387).

`@encrypted` on a `Json` field **silently destroyed the value**. `encryptField`
does `String(plaintext)`; an object stringifies to `'[object Object]'`, and what
went into the column was a faithful AES-256-GCM ciphertext of that literal
string. Nothing threw. The row looked correctly encrypted. The original was
unrecoverable.

```js
await db.vault.create({ data: { blob: { secret: 'hunter2', n: 42 } } })
// before → "[object Object]"
// after  → { secret: 'hunter2', n: 42 }
```

`ISSUES.md` FJS-006, S1. It had been "mitigated" by a `CLAUDE.md` hazard note
telling people to declare `String @encrypted` and serialize by hand — that note
is now removed.

### The fix is two points, because the pipeline is already symmetric

The write path encrypts and *then* serializes (`serializeRow(..., jsonFields)`);
the read path parses and *then* decrypts (`read()` → `applyFieldPolicy`). So a
Json field only needed its own serialization stepped inside the encryption:

- **encrypt:** `JSON.stringify(val)` before `encryptField`, so what is encrypted
  is text rather than `String(object)`.
- **decrypt:** `JSON.parse` after `decryptField`, mirroring it.

Keyed on the **declared** type — `json: field.type?.name === 'Json'`, captured in
`buildFieldPolicyMap` beside the other per-field facts, because neither call site
has the schema in scope. Keying on "the value looks like JSON" would have parsed
a `String @encrypted` field that happens to hold `{"a":1}`.

### What is covered

Objects, nested structures, arrays, and the JSON scalars (`string`, `number`,
`boolean`) — the scalars matter because `String(plaintext)` handled *those*
correctly, so a fix that only special-cased objects would have passed the obvious
tests and quietly double-encoded the rest. `null` stays null. `@secret`,
`$rotateKey` and `@encrypted(searchable: true)` all verified on a Json field; an
unencrypted Json field on the same model is untouched, and `@encrypted` still
implies `@guarded(all)`.

Verified beyond round-tripping: the stored column is ciphertext, and the
plaintext does not appear anywhere in the database file. A round-trip test alone
would also pass if the field were simply not being encrypted.

### Legacy rows read as the broken string, not null

Data written before this is already lost and cannot be recovered. A parse
failure therefore leaves the decrypted value alone rather than nulling it: `null`
reads as "this was empty", `'[object Object]'` reads as "something went wrong
here", and only the second sends anyone looking.

9 tests; **4 fail if the fix is reverted**.

## 2026-08-06 — authorship is one line, and cannot be forged

1387 tests (was 1370).

`@@createdBy` and `@@updatedBy` on a model each expand at parse time into the
pair of fields you were writing by hand:

    model Doc { id Int @id  title String  @@createdBy  @@updatedBy }

    // → createdById Int?  @createdBy
    //   createdBy   User? @relation("Doc_createdBy", fields: [createdById], references: [id])
    //   updatedById Int?  @updatedBy
    //   updatedBy   User? @relation("Doc_updatedBy", fields: [updatedById], references: [id])

Pure desugaring — nothing downstream knows the attribute existed. DDL emits both
foreign keys, `include: { createdBy: true }` resolves, typegen and JSON Schema see
ordinary fields. The FK type is copied from the `@@auth` model's `@id`, so an `Int`
id and a `String @default(uuid())` id both land right. `@@createdBy(owner)` renames
the pair. A field you already declare under either name wins and is left alone.
Without a model marked `@@auth`, both are a schema error — the same ruling
`@scoped` already makes.

**The field-level `@createdBy` is new, and it is a stamp, not a default.** The
obvious expansion was `@default(auth().id)`, and probing it is what killed that:

    const asAnn = db.$setAuth({ id: 1 })
    await asAnn.doc.create({ data: { title: 'x', createdById: 2 } })
    //  → createdById: 2      ← Bob. A default loses to the payload.

Authorship you can forge by adding a key to the request body is not authorship.
`@createdBy` overwrites instead, matching `@updatedBy`, which had these semantics
all along. Both are skipped entirely when `ctx.auth` is null, so `asSystem()`
writes, seeders and backfills still carry an explicit author in — that is the
only way a migration can.

Stamped on `create`, `createMany` and both `upsert` paths; the upsert fast path
stamps the INSERT branch only, so a conflict does not rewrite the original
author. `upsertMany` and `updateMany` were the two paths that stamped nothing —
see the entry below, which closes that as `FJS-092`.
`generateFactory` skips both attributes, and typegen drops them from the
`*Create` interface: a value there loses to the principal anyway.

## 2026-08-05 — every bulk write reaches the audit trail

1370 tests (was 1362).

`updateMany` and `deleteMany` on a model declaring `@@log` wrote **no audit entry
at all** — not an entry without snapshots, no entry. Both called `fireQuery` and
never `emitLogs`, and so did `removeMany`, `restore` and `upsertMany`. Probed
rather than read:

    createMany 3 rows · updateMany 3 · deleteMany 3   →  entries: 2 (the creates)

Two bulk writes destroyed three audited rows and the trail said nothing happened.
An append-only trail that omits the most destructive operation in the API is worse
than no trail, because it is trusted.

All five paths now log. `createMany`'s entry named no rows for the same underlying
reason — an `@id @default(autoincrement())` row has no id until SQLite assigns one,
and the entry was built from the pre-insert data — so the bulk paths take
`RETURNING` on a logged model and name their rows by id. An unlogged model is
untouched: the `RETURNING` path is guarded by `tableHasAnyLog`, so `run()` still
serves the common case.

Details worth knowing:

- **A bulk write records which rows and what operation, never contents.**
  `before`/`after` stay single-row-only, as documented. Naming the rows is what
  makes the trail complete; snapshotting a million-row update is a different
  feature with a different cost.
- **`upsertMany` splits its batch** into a `create` entry and an `update` entry.
  It looks up which conflict keys already exist *before* writing — one prepared
  `SELECT` per row, on logged models only — because after the write every row
  looks like an update.
- **`restore` logs as `update`.** The vocabulary is create|update|delete|read, and
  a restored row changed state; it was not created.

`docs/audit-logging.md` said "`before`/`after` snapshots are only included for
single-row `update()` calls — not `updateMany()`", which reads as *the entry exists
without snapshots*. It did not exist. Corrected there, along with three `db.auditLog`
call sites that should be `db.auditLogs`.

Repo register: `ISSUES.md` FJS-074.

## 2026-08-05 — a transaction can read its own writes

1362 tests (was 1355).

`$transaction` opened a write transaction on the write connection and then handed
the callback the ordinary client, whose reads go to the separate readonly WAL
connection. WAL isolation means that reader cannot see uncommitted work, so:

    await db.$transaction(async (tx) => {
      await tx.t.create({ data: { name: 'a' } })   // succeeds, returns the row
      await tx.t.findMany()                        // → []
      await tx.t.count()                           // → 0
    })

Every read-after-write inside a transaction saw stale data — check-then-act,
read-modify-write, and any `include` resolved against a parent created moments
earlier. Nothing threw; the reads simply described the world as it was before the
transaction started.

Each read connection is now wrapped in a router sharing the transaction manager's
depth. While a transaction is open, reads go to the **write** connection, which
observes its own uncommitted work; outside one, nothing changes and reads still run
concurrently on the readonly connection. The two prepared-statement fast paths
(`findMany()` with no args, `findUnique` by pk) stand down inside a transaction —
they were prepared against the read connection at table-build time and cannot be
re-pointed.

Read-only clients are untouched: their write connection is a throwing stub, and
they can never open a transaction to route into.

Found while trying to build per-test isolation on `$transaction` for the seeding
work below. Pinned by seven tests: findMany, findUnique, read-modify-write,
`include`, rollback, routing restored after commit *and* after rollback, and
nested savepoints.

## 2026-08-05 — seeding ergonomics

1355 tests (was 1334).

Six additions and one retry, all on top of the relation work below.

- **`snapshot(db)` / `restore(db, snap)`** — seed once, reset between tests. A
  truncate + bulk re-insert of the exact rows, which beats re-seeding. Deliberately
  raw: rows move through the write connection, so `@encrypted`/`@secret` columns
  keep the ciphertext they already have (a round trip through the ORM would
  re-encrypt them) and no gate, policy, hook or audit entry fires. FTS5 shadow
  tables are skipped — writing those directly corrupts the index.
- **`defineFactory({ model, definition, traits, afterCreate })`** — the Factory
  without the class. Returns a class, so it registers exactly as before. A subclass
  declares `traits` as an instance field, which initialises only after `super()`
  returns; that is the only reason `Factory`'s constructor returns a Proxy, and
  this path never needs it.
- **A value catalogue** (`src/fake.js`). Well-known field names — `firstName`,
  `city`, `company`, `title`, `description`, … matched case- and
  separator-insensitively — draw real words instead of `Name a4f2`. **Only when a
  seed was set.** Unseeded output is byte-identical to before, because
  schema-derived test *cases* have to stay stable and diff-able.
- **`static dependsOn = [OtherSeeder]`** — a seeder names what it needs instead of
  every caller knowing the order. Each class runs at most once per `call()`; a
  cycle throws naming the classes in it.
- **`loadFixture(db, model, jsonOrCsvOrArray, { upsert })`** — authored reference
  data (countries, plans, currencies) is written down, not generated. Rows go
  through the ORM, unlike `restore`. Ships a small RFC-4180 `parseCsv`.
- **`fli make:factory <Model>`** — scaffolds a `defineFactory` stub into
  `db/factories/`, refusing a model the schema does not declare.
- **UNIQUE collisions retry.** Generated values carry a seq token so a `@unique`
  column is unique by construction, but the token pool is finite and the catalogue
  is small. `createOne` now rebuilds and retries (5 attempts) — a rebuild advances
  `seq`, which changes every generated value — rather than failing a long seed.

`withParents()` also stops **silently skipping** a required relation whose target is
already in the parent chain. A cycle cannot be satisfied by creating more rows, so
it now says that, names the chain, and suggests `.for(…)` — previously it surfaced
as an opaque `FOREIGN KEY constraint failed` far from the cause.

### Why snapshot/restore rather than a transaction

The intended implementation was a per-test transaction rolled back at the end.
`$transaction` could not serve it: reads inside one did not observe its own writes.
That turned out to be a general correctness bug rather than a test-helper problem,
and is fixed in its own entry above. `snapshot`/`restore` remains the isolation
primitive here — it survives a client restart and does not hold a write lock for the
length of a test.

## 2026-08-04 — factories can seed a relation graph

1334 tests (was 1321).

Factories could only reach one relation shape: `withRelation`/`for`, a single named
belongsTo, wired by hand. Everything else was on the caller. Measured by pointing
`autoFactories` at the two real schemas in this repo and creating one row per model:

    example  (Int keys)   3 of 3  models seeded
    basecamp (uuid keys)  5 of 24 models seeded

The 19 failures were all `FOREIGN KEY constraint failed`. An `Int` FK falls back to
`1`, which accidentally works when the parent happens to be row 1; a `String`/uuid FK
has no fallback at all, so the generator emitted `"AccountId 1"` and every write with
a parent failed. Four additions:

- **`withParents()`** — reads the schema and auto-creates a parent for every
  *required* belongsTo, recursively. `{ optional: true }` covers nullable ones,
  `{ fresh: true }` gives each row its own. Relation cycles are skipped rather than
  followed; `depth` is only a backstop.
- **`has(name, count, opts)`** — hasMany children, created after the parent with the
  FK pointed back at it. The FK comes from the child's own `@relation`; a child with
  two relations to the same parent is an error naming both, not a guess.
- **`attach(name, countOrRows)`** — implicit many-to-many, via the `{ connect: […] }`
  form the client already takes. Accepts a count or existing rows.
- **`usingDb()` / `asSystem()` / `actingAs()`** — a schema declaring any `@@gate`
  auto-installs GatePlugin, so an anonymous factory grades STRANGER and cannot create
  anything. The client now propagates through the whole wired graph; rebinding only
  the top factory left every parent on the gated client.

`has`/`attach`/`withParents` need the parsed schema and a factory registry, which
`makeTestClient({ autoFactories: true })` and `factoryFrom()` now supply — to
hand-written factory classes as well as generated ones. Without them the methods
throw a message naming what to pass.

Same measurement after:

    example   3 of 3  models seeded via factories.X.asSystem().withParents()
    basecamp  24 of 24

## 2026-08-04 — the factory generator stops emitting data the schema rejects

1321 tests (was 1306).

`generateFactory` derives a row from a model's field types. It was not reading most
of the rules on those fields, so `autoFactories` produced rows that could not be
written. Probed with one hostile model — every line below is a separate failure:

    { code:"xxxx", phone:"Phone c9zs", age:11001, meta:null, tags:[], plan:"free" }

    createOne     → phone: must be a valid phone number, age: must be at most 99,
                    meta is required, ref: must match ^[A-Z]{3}-[0-9]{4}$
    createMany(2) → UNIQUE constraint failed: code.v

- **`@unique` + `@length` generated a constant.** The whole branch was
  `'x'.repeat(min)` — no seq — so the second insert always collided. Every string
  now carries the seq token and is padded/truncated into the declared range.
- **`Int` ignored `@gte`/`@lte`**, and both types ignored exclusive `@gt`/`@lt`.
  One bounds resolver now serves `Int` and `Float`, and the value walks the range
  with `seq` so a bounded `@unique` column also survives `createMany`.
- **Required `Json`/`Bytes` generated `null`** → "is required" on every write. Now
  `{}` / bytes when required, `null` only when optional.
- **`@phone` was unhandled** → plain text, always invalid.
- **`@regex` emitted `field-abcd`**, which matches almost no pattern. There is now a
  generator for the common subset (anchors, escapes, classes, groups, alternation,
  quantifiers) that **checks its own output against the pattern** and warns instead
  of emitting an invalid value.
- **`@minItems` was ignored** — arrays were always `[]`.
- **`@startsWith` / `@endsWith` were ignored.**
- **`DateTime` used `new Date()`**, so a seeded factory was not reproducible — the
  one promise the seeded-RNG design makes. Derived from `seq` now.
- **Enums always returned the first value** — five seeded builds gave five `free`.
  `rng.pick` when seeded; still the first value unseeded, so generated test cases
  stay stable.
- **`@sequence` columns are no longer emitted.** An explicit value is honoured and
  moves the per-scope counter (verified), so writing one both defeats the feature
  and collides with any `@@unique([scope, seqField])` beside it.

### makeTestClient could open the project's real database

Found while running the above against `packages/basecamp/db/schema.lite`: rows
appeared in tables that should have been empty. `makeTestClient` builds a throwaway
db in a tmpdir and passes it as `db:` — but **a `database` block in the schema wins
over `db:`**, which is documented litestone behaviour. So pointing this helper at a
real app schema opened `./db/basecamp.db` — the actual project database — and wrote
test rows into it. The docs said "always uses `:memory:` — no files created".

It now overrides every declared database path into the tmpdir, one file per declared
database, with per-database DDL. Pinned by two tests, including one asserting the
declared path is never created on disk.

## 2026-08-04 — `Factory.create(overrides)` no longer returns nothing

1306 tests (was 1302).

`build(n, o)` and `create(n, o)` branched on `n != null`, so the first argument was
a count whenever it was present at all. Laravel's `factory()->create($attrs)` is the
muscle memory everyone brings, and `factory.create({ role: 'admin' })` took the
overrides object as the count:

    Array.from({ length: {} })   // → []

No row written, nothing thrown, an empty array returned where a row was expected.
Both now branch on `typeof n === 'number'` — a number is a count, anything else
(object or function) is overrides. All four forms are pinned by tests:

    create()                    → 1 row
    create({ role: 'admin' })   → 1 row with overrides
    create(5)                   → 5 rows
    create(5, { role: 'x' })    → 5 rows with overrides

**Types corrected alongside.** `index.d.ts` described a `Factory` that does not
exist — `for(relatedId)` and `withRelation(model, id)` have taken
`(name, row|factory, fk?, pk?)` for as long as they have existed, `afterCreate` is a
subclass field and not a fluent method, and `seed`, `traits`, `build` and `create`
were undeclared. `testing.d.ts` typed `factories` and `factoryFrom` as `unknown`,
claimed `generateFactory` "returns code as string" (it returns the
`definition(seq, rng)` function), and gave `generateGateMatrix` /
`generateValidationCases` return shapes neither one has ever produced —
`{op, level, label, expect}` and `{valid, invalid, boundary}`, not what was written.

`docs/testing.md` told you to write `model = 'users'` and
`factoryFrom(schema, 'users', db)`. Lowercase plural throws
`model "users" not found in schema` — model names are PascalCase singular
(Invariant 2). README had it right; the doc had drifted.

## 2026-08-04 — transition errors carry an HTTP status

1302 tests (was 1298).

`TransitionGateError` always set `this.status = 403`, with a comment saying that
is the contract: Junction reads `err.status` directly, so an error class you own
needs no mapper and no registration. The other three were missed, so a caller
asking for an illegal move got `500 GeneralError` — the wrong class of error
entirely, telling a client to retry something that will never work.

    TransitionViolationError  → 409   conflicts with the row's current state
    TransitionConflictError   → 409   optimistic-lock loss; also retryable: true
    TransitionNotFoundError   → 400   named a move the model does not declare

Found by driving `@@transitions` from a UI for the first time in `example/`.

## 2026-08-04 — @label and @required, and messages that leave the Data boundary

1298 tests (was 1289).

Every validator already took its own wording — `@length(3, 20, "…")`,
`@email("…")`, `@gte(0, "…")`, the ZenStack convention — and this package's own
validator honoured them. `generateJsonSchema` emitted **none** of them, so a
sentence authored once in `db/schema.lite` died here: invisible to Junction's
autoValidate and to Sierra's client-side rules, both of which derive from that
document. A form said `customerId is required` and no amount of schema
authoring could change it.

**Messages are now emitted as `x-messages`**, keyed BOTH by rule name and by
the JSON Schema keyword the rule compiles to — `@length` publishes under
`length`, `minLength` and `maxLength`. Keying by keyword is the point: a
consumer that just failed `minLength` looks up `minLength`. The alternative,
publishing only the rule name, puts a keyword→rule table in Junction *and*
Sierra, and this file is the one that already owns that mapping (it is
documented at the top of it). `MESSAGE_KEYWORDS` is pinned by a test asserting
the aliases match what the field actually emits — `@gt` is `exclusiveMinimum`,
not `minimum`.

**`@label("Customer")` → JSON Schema `title`.** Every generated message on
every side builds its sentence from it, so an error stops reading `customerId`
under a form label that says "customer". Consumers must read it off the
FIELD's own schema and never a `$ref` target: every enum `$def` is titled with
the type name, so a deref'd title would make `status OrderStatus` introduce
itself as "OrderStatus".

**`@required("…")`** fills the one gap the trailing-message convention could
not: required-ness is the absence of `?`, not an attribute, so there was
nowhere to hang a message. ZenStack reaches for model-level
`@@validate(expr, msg)` here; this follows Remult's field-level
`Validators.required(msg)` so the wording sits beside the rule like every other
message in the file. It carries the wording only — it does **not** make the
field required, and on an optional field it is a parse error rather than a
message that could never fire.

Nine tests in `test/messages.test.ts`.

Newest first. Entries older than 2026-08-02 live in `PROJECT_STATE.md` §What's
been done (phases 1–10) — this file starts where that log left off.

## 2026-08-03 — `@@transitions`: state machines move to the model, and gain gates

A `status` column's rules used to live in whatever service handler was written
first. They are now declared once on the model, enforced at the Data boundary,
and readable by the browser.

```prisma
enum OrderStatus { pending  paid  shipped  refunded  cancelled }

model Order {
  status OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

**What's new**

- **`@@transitions(field, …)`** on the model, beside `@@gate` and `@@allow`
  where every other access declaration already lives. The transition name is
  optional (`pending -> paid` names itself after the target); `from` takes a
  list; a trailing `@gate(N)` takes a number or a level name.
- **`@gate(N)` per transition** — a floor on top of `@@gate`'s update level,
  which had to pass to reach the write at all. Shipping an order and refunding
  one are not the same authority. Under-level moves throw the new
  **`TransitionGateError`**, which carries its own `status: 403` so Junction
  maps it with no registration.
- **`db.order.transitions(row)`** — the legal next states for *this* record at
  *this* user's level. A gated move the caller can't make comes back with
  `allowed: false` rather than being dropped; a disabled button is usually
  better UI than a missing one. Takes a row (no round trip) or an id.
- **`x-transitions` on the model in `generateJsonSchema`**, so the machine
  reaches the browser. Sierra's `resource.transitions(row, level)` returns the
  identical shape — a UI affordance only, the server enforces regardless.
- A gated transition **auto-installs a level resolver** when the app configures
  no `GatePlugin`, the same way `@@gate` does. A declared gate that silently did
  nothing would be a fail-open default.

**Why the model and not the enum**

The existing `enum X { transitions { … } }` block attached rules to the *enum*,
so every model with a field of that type shared one machine — and therefore
would have had to share one authority level. Two models using one `Status` can
now differ. The enum block is kept as shorthand for the common case and
**desugars into `@@transitions`** at parse time, so there is one enforcement
path, one representation in the JSON Schema, and the existing behaviour is
unchanged (all 20 of its tests pass untouched). A model that declares its own
`@@transitions` for that field overrides the enum's outright.

**Breaking**

- `x-litestone-transitions` is **no longer emitted on the enum `$def`**. The
  resolved machine is on the model as `x-transitions`. Emitting both would give
  a client two sources that drift the moment one model narrows.

**Documentation corrections** — three places described syntax that never
existed: `docs/schema.md` documented a `@from(pending)` enum-value attribute,
and `docs/roadmap.md` and `docs/soft-delete.md` both showed an array form
`@@transitions([{ name, from, to }])`. `docs/soft-delete.md` additionally
claimed `remove()` enforces transitions — **it does not**, and never did;
enforcement runs on `update()` and `upsert()` only. Use a `@@deny('delete', …)`
policy to require a state before deletion.

1286 tests green (was 1253).

## 2026-08-03 — `@encrypted` on a `Json` field silently destroys the value

**Open. Not fixed — route around it.**

A `Json @encrypted` column round-trips as the string `"[object Object]"`. The
value is stringified with `String(obj)` instead of `JSON.stringify` before it
reaches the cipher, so the object is gone before encryption ever happens.

Everything *around* it works, which is what makes it dangerous: the column is
genuinely encrypted at rest, `@guarded(all)` read-withholding is enforced, the
write returns normally, nothing throws and nothing warns. Only the payload is
missing, and only on read-back.

```prisma
model Secret {
  data  Json @encrypted     // ← writes {"key":"…"}, reads back "[object Object]"
}
```

**Workaround:** declare the column `String @encrypted` and do the
`JSON.parse` / `JSON.stringify` at the service layer. That is what
`packages/basecamp/db/schema.lite` does — see `packages/basecamp/db/README.md`
§"A Litestone bug to route around".

Also recorded in `docs/gotchas.md`.

---

## 2026-08-03 — the audit logger was never dropping rows; reads lag writes

Reported repeatedly as "**`@@log(audit)` writes 0 rows**", including in the root
`CLAUDE.md`, where it sat unexplained for weeks. It is not a bug and nothing is
lost.

The logger driver buffers and flushes on a **~1s timer and on process exit**, so
a read in the same session immediately after a write sees nothing — and the
`.jsonl` file may not exist yet. Litestone's own examples read straight after
writing, which is exactly the shape that reports zero.

Measured on a fresh database:

| after | `auditLogs.findMany()` | file |
| --- | --- | --- |
| 1 write, immediately | 0 rows | does not exist |
| +2s | 1 row | 297 B |
| +50 more writes, same process | 1 row | 297 B |
| next process | **51 rows** | 15,137 B |

Entries carry `operation` / `model` / `records` / `before` / `after` /
`actorId` / `createdAt`, and are queryable through the **`auditLogs`** accessor
that declaring a logger database synthesizes.

Two related facts worth keeping together with this one:

- **`@secret` expands to `@encrypted + @guarded(all) + @log(<first logger db>)`.**
  Merely *declaring* a logger database therefore starts logging every `@secret`
  field in the schema. That is by design.
- **The logger `path` resolves against the process CWD, not the schema file.**
  Where the trail lands depends on where you launch from.

### Protected fields are redacted (same date, and this is what makes the above safe)

`src/core/client.js`. Any `@encrypted` / `@guarded` / `@secret` value is written
as `'[redacted]'` in **both** the field-level entry and the model-level
`before`/`after` snapshot. The trail records *that* a field was written, by
whom, to which rows, when — never what it holds.

- `null` is preserved rather than redacted: nothing to leak, and it keeps a
  `null → value` transition visible (`before: null, after: '[redacted]'`).
- Unprotected fields on the same model are still logged in full.
- The row returned to the caller is untouched — redaction happens on a copy, on
  the way to the log.

**Before this fix the plaintext landed in the JSONL while the database row was
correctly ciphertext**, so any audit file written before 2026-08-03 may hold
secrets in the clear. Consumers that log identity or credential models —
`packages/basecamp` does, on all 16 of its non-event models — require a
Litestone from this date or later.

Pinned by 8 tests (`test/litestone.test.ts` → "audit log redaction"), 5 of which
fail if the redaction is removed. Reference docs: `docs/audit-logging.md`
§"Protected fields are redacted".

---

## 2026-08-02 — v1.1.0 published; the dialect trap is closed

**The trap:** in-repo packages resolved a *registry* Litestone rather than the
workspace one, so schemas written against the current dialect
(`Int` / `String` / `Float` / `Bytes`) were parsed by a build that still spoke
`Integer` / `Text` / `Real` / `Blob`. The failure surfaced far from its cause —
Junction carried **7 test failures filed for months as "test drift"** that were
this mismatch and nothing else. Fixing the resolution cleared all 7.

Two halves, both closed:

- **In-repo:** junction and auth now take `workspace:*` as a dev-dependency with
  a `^1.1.0` peer, so workspace code gets the workspace parser.
- **Registry:** 1.1.0 is published and npm `latest` points at it. Verified by
  `npm view` dist-tags *and* by unpacking the tarball — `SCALARS` carries
  `Int/String/Float/Bytes` and `RENAMED_TYPES` rejects `Integer/Text/Real/Blob`.

**Type renames are a hard cut, not aliases.** `Text`, `Integer`, `Real` and
`Blob` are rejected outright with a rename message (`PROJECT_STATE.md` §"Type
rename — hard cut").

**Still true, and the reason this went unnoticed for so long:** don't pin
Litestone with a bare `"latest"` or `"*"`. A floating range is what let a
consumer silently sit on the old dialect. Use `^1.1.0`. Anything installed from
the registry before 2026-08-02 needs a reinstall.
