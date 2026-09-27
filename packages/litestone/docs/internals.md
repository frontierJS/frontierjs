# Litestone internals

Why the code is shaped the way it is. Each entry is a rule a change must keep,
the failure that established it, and the `FJS-###` / `FJS-D###` that records it.
`../CLAUDE.md` is the map and points here; the traps a CONSUMER of litestone hits
are the `data-hazards` skill and are not repeated here.

Read the section for the path you are changing before changing it.

## Reads

- **A read that builds its own SELECT has to compose what `buildSQL` composes.**
  Global filter, plugin read filters, soft-delete, `@@hasTemplates`, the
  caller's where, then the policy — in that order, because positional binds make
  the order the correctness. `findManyCursor` and `search()` applied none of the
  first four and neither the policy, so `findMany` answered one row where they
  answered every row in the table (`FJS-262`). And a `@@gate` lives in a
  plugin's `beforeRead`: `aggregate`, `groupBy` and `search` never called it, so
  a gated model answered a refused caller's COUNT while its row policy — which
  DID apply — made the number look scoped. The grid in
  `test/litestone.test.ts` § *every read applies the filter, the policy and the
  gate* is what a new read method has to pass.
- **A tree read goes through the ordinary read path, and it has to stay that
  way.** `findMany({ recursive })` resolves ids in a CTE and fetches the rows
  with `findMany`, so the gate, the policy, the select and the derived fields
  have one owner each. It was a second SELECT path once, and it asked none of
  them past the anchor row: a caller refused on the model read its whole subtree
  (`FJS-216`). The walk carries the anchor's visibility predicate, so an
  invisible node hides its branch — reparenting orphans upward hands back the
  children of a refused row. Only `findMany` walks a tree; every other read
  refuses `recursive` by name.
- **A `@from` correlates on EVERY column of its relation's key, and that is
  three places rather than one.** The subquery's WHERE, the `first`/`last`
  repick (`IN` over row values, `PARTITION BY` over all of it, a JSON tuple as
  the lookup key), and `parseSelectArg`'s injection of the correlation columns
  for a `select` that named only the derived field. Correlating on the first
  column alone answered a count of every row sharing it — 8, 8, 7 where the
  truth was 3, 5, 7 — and nothing could raise it, because that is a count of
  real rows (`FJS-377`). `inferFromFk` answers `{fkCols, refCols}`, aligned
  arrays; a single-column relation is a one-element case of the same code.
- **A `@from(first/last)` field is an id in SQL and a ROW after `read()`.** The
  subquery resolves the target's primary key; `resolveFromRowRefs` fetches the
  rows in one batched query and swaps them in, before `applyComputed` so a
  parent computed reading `row.lastOrder.amount` sees a row. It was a
  `json_object` of the target's columns, which filtered out the *virtual*
  attributes and left the *protective* ones — so it returned `@guarded`,
  `@omit(all)` and `@encrypted` values to any caller (`FJS-223`) while missing
  the target's own `@computed`/`@from` (`FJS-222`). Protections live in `read()`;
  anything that assembles a row without it will leak them. The three include
  branches share `finishRelated` for the same reason — each had its own copy of
  deserialize → compute → shape, and a step added to one missed the other two.
  **On a policied target the id from SQL is discarded and the pick is redone**
  under the caller's policy, with `ROW_NUMBER()` choosing per parent — the
  startup subquery cannot know `ctx.auth`, so it picked the newest row that
  exists and a denied one read as `null` rather than falling through to the next
  visible one (`FJS-224`). The repick correlates on the column the target points
  back at, which `parseSelectArg` injects like an FK, so a narrow `select` still
  gets it right.
- **A `@from` applies the TARGET model's `@@softDelete` and `@@hasTemplates`.**
  Same as `include: { _count: true }` over the same relation. `withDeleted: true`
  / `withTemplates: true` opt back in; an explicit `where:` composes on top.
- **A `@derived` field is built into the SAME map as `@from`, and that is why it
  reaches every read.** Both are virtual columns carried in the SELECT,
  filterable through `_fromExprMap` and stripped from writes by `stripVirtual`,
  so the six SELECT-building sites, the WHERE substitution and the ORDER BY all
  work unchanged — a seventh that forgot it would be silent, the way a forgotten
  `@from` is. It carries no params: compiled once at startup, `now()` emitting
  SQLite's own clock, which SQLite fixes for the duration of a statement.
  `aggregate`/`groupBy` build their own SELECTs and substitute the expression
  where a column name would go, or `MAX("urgency")` answers `'urgency'`
  (`FJS-202` through a new field kind). `auth()` is refused — a derived field is
  one value for the ROW, and per-caller is `@@scope` (`FJS-233`).
- **A `@computed` field the `select` did not name is not computed at all**, and
  one that declares `needs` narrows the SELECT to what it listed. A **bare** fn
  still widens to `SELECT *` — undeclared has to mean fetch everything — so one
  bare fn in a select widens it for the declared ones too. A declared fn is
  handed only its declared names and **throws** on any other read; that guard is
  what makes the narrow fetch safe, because the alternative is `undefined` and a
  plausible answer. `@from` values are resolved first, so a computed field may
  read one, and naming one in `needs` emits just that subquery.
  **Six sites build SELECTs of their own** — the
  query pipeline, `findManyCursor`, `search()`, `resolveIncludes` (×3 relation
  shapes) — and each has to append the `@from` subqueries itself;
  `fromSelectExpr()` / `deserializeFromRow()` are the shared definition.
  Forgetting one is silent, not loud: the field goes absent and `applyComputed`
  still runs, so a computed field over it answers a plausible `0`.
- **A `@computed` field cannot be sorted, and `orderBy` now says so.** It is a JS
  function over a fetched row; SQLite cannot order or paginate by one. Both that
  and an unknown key THROW — stricter than the where-key check, which only warns
  on a read, because a bad filter returns fewer rows and a bad sort returns the
  right rows in the wrong order. `@from` sorts fine (it is a subquery in the
  SELECT). `db.$checkOrderBy(accessor, orderBy)` asks without running the query.
- **Nor can a column whose stored TEXT is a storage detail** — an array or a
  `Json` document (a serialization), a `File` (a reference), `@encrypted` or
  `@hashed` (an encoding). SQLite orders by that text, so `[10]` sorts before
  `[9]` and ciphertext reshuffles on every re-encryption. One bucket,
  `reason: 'opaque'` (`FJS-200`). An implicit m2m (`Tag[]`) is an array in the
  AST and a join table in SQLite — it is claimed as a RELATION before the array
  bucket sees it, or `orderBy: { tags: { _count } }` stops compiling.
- **An aggregate NAMES a column and builds no row, so it has to do both halves
  of `read()` itself.** Neither was done. A name that is not a column reaches
  SQLite as a quoted identifier, which it resolves as a string CONSTANT — so
  `_max: { comp: true }` answered `"comp"`, `_sum` answered `0`, and a plain
  typo did the same (`FJS-202`); and nothing stripped a protected column, so
  `_max` over a `@guarded` salary answered it, `_stringAgg` over one answered
  the whole column joined with commas, and `by: ['salary']` answered every
  distinct value with a count (`FJS-273`). **Eight arguments can carry a field
  name** — `_min`/`_max`/`_sum`/`_avg`, `_stringAgg`'s `field` and `orderBy`, a
  named aggregate's field, `_count: { distinct }` — plus `groupBy`'s `by` and
  `interval`. Two tiers: `by`/`distinct`/`interval` need a real column and
  nothing more (grouping stored text is self-consistent), everything producing a
  VALUE also refuses the opaque bucket. `fieldReadRefusal` mirrors
  `applyFieldPolicyTo`'s strip ladder over a name; a field-level
  `@allow('read', …)` is refused rather than evaluated, because it is a
  predicate over a row. The grid in `test/litestone.test.ts` § *an aggregate
  names a column* is what a new argument has to pass.
- **A bare array in a `where` is not `equals`, on either kind of column.** It
  means *the column's value is in this list* — `IN` for a scalar, `IN` inside
  `json_each` for an array column, which is `hasSome`. **Prisma reads it as an
  exact match**, so a schema ported from there filters wider than it did. The
  exact, ordered comparison is `{ equals: [...] }`.
- **Columns are emitted verbatim camelCase; `DateTime` is ISO-8601 TEXT.** Hand-
  written SQL assuming snake_case or epoch-ms will not match — **and neither do
  SQLite's own clock functions.** `datetime('now')` answers `2026-08-13
  07:38:31`, the stored value is `2026-08-13T07:38:31.984Z`, the comparison is
  string-wise, and `'T'` sorts above a space: every row stored TODAY compares
  greater than a same-day `datetime('now')`, so the predicate is right for
  yesterday and wrong for this morning (`FJS-226`). `now()` is the spelling that
  matches, and the six forms that cannot are refused by name — in the `sql` tag,
  in a plain-string `$raw`, and in a `@from(where:)` at startup. `julianday()`
  is untouched: it answers a number, so it compares like with like.
- **A protection that only STRIPS is not a protection.** `@guarded` hid its value from every read and let the same caller name the column in a `where`, which recovers it one `startsWith` at a time, and in an `orderBy`, which leaks the ordering of every row at once (`FJS-393`). The refusal is `collectGuardedArgs` in `client.js`, at the read where `ctx.isSystem` is known — NOT in `filterableKeysFor`, which answers whether a column CAN be compared and is therefore the same answer on every flavor of client, which is what lets junction ask `$checkWhere` of a caller's own. **It walks the relation graph**, because the filter grammar does: `where: { author: { is: { … } } }`, a relation `orderBy` and a nested `include` all ask about a model the table is not. `ctx.guardedMap.reaches` is the gate — a model from which no guarded column is reachable at any depth costs one boolean — and the walk descends only into a relation key or a logical/relation operator, since a nested object under an ordinary column is a typed-Json path where a key sharing a guarded column's name means something else. The sibling hole through a field-level `@allow('read', …)` is open and measured (`FJS-442`): a predicate is not a set, and refusing it needs a ruling first. **A credential lookup is now a system read by construction** — a `Session`/`Invitation`/`ApiKey` token is `@guarded` and found BY its value, so `where: { token }` on a caller's client is refused; auth and basecamp already went through `asSystem()` for it, and the comment in `invitations.service.ts` says why. Allowing bare equality instead would have kept them working and left the hole open for anything low-entropy, which is what a probe enumerates.
- **An FTS index mirrors its table, soft-deleted rows included** — `search()` is
  the only reader and does the filtering, which is what makes its
  `withDeleted`/`onlyDeleted` mean anything. Keeping deleted rows *out* of the
  index needs a second trigger, and two triggers firing on one soft delete is
  what made `@@softDelete` + `@@fts` unusable: FTS5 answers a repeated `'delete'`
  for one docid with `database disk image is malformed`, and only when the extra
  delete empties the structure — above one row it corrupts in silence.

### A tuple key is not a unique column

**`@@id([a, b])` stamps `@id` on EVERY member**, so asking the fields which
column identifies a row answers all of them — and one member of a tuple
identifies nothing. Three faults came out of that single read and the worst is
silent (`FJS-694`): with `orderBy: { userId }` on `@@id([userId, teamId])`,
three rows sharing a userId paged two at a time served the first two and then
answered EMPTY, because the tie-break thought the ordering was already total and
the cursor said `userId > 1`. Beside it, the default ordering was the literal
`id` — a column such a model does not have, so every derived list over one was a
400 — and the tie-break appended only the key's FIRST column, which is still not
total.

`_keyCols()` reads the model ATTRIBUTE, because that is the only place the key's
column ORDER is stated, and `$primaryKey(accessor)` is the same answer for the
layer above. `normalizeOrderBy` still defaults to `id` and must: it is pure and
has no model in scope, so the default belongs at the caller that has one.

## Writes

- **`@system`, `@guarded`, `@computed` and `@transient` are one grid, and the two
  questions are *is there a column* and *which way does the value travel*.**

  |              | column | caller writes | caller reads |
  | ------------ | ------ | ------------- | ------------ |
  | `@guarded`   | yes    | system only   | system only  |
  | `@system`    | yes    | system only   | anyone       |
  | `@computed`  | no     | no            | yes          |
  | `@transient` | no     | yes           | no           |

  `@computed` and `@transient` are mirrors, which is what decides everything
  downstream rather than deciding it twice: computed is emitted into the READ
  modes of the generated schema and transient into the WRITE ones, computed is
  out of the create/update types and transient is out of the row type and out of
  `Where`. Neither is a column, so `isStoredField` in `ddl.js` is the one answer
  to that — `CREATE TABLE` and the rebuild's `INSERT … SELECT` were asking it
  separately and had drifted. A transient field is refused by name in a `where`,
  an `orderBy`, an aggregate, a policy predicate and a `@@index`, because SQLite
  reads an identifier it cannot bind as a string literal: the filter matches
  every row or none, and nothing says so.

  Both refuse a write BY NAME rather than dropping it, because the client is told
  `readOnly` and a generated form does not offer the column — so a payload
  naming one is code that meant to write it. A field `@allow('write', …)` still
  drops silently, and must: there the same payload is legitimate for another
  caller. The pair `@guarded @system` is legal and means both halves; a
  field `@allow('write')` beside `@system` is refused, because one says nobody
  ever and the other says it depends who is asking.
- **`upsertMany` is TWO writes and they are policed by two different rules.** A
  row that will INSERT is a create and one that will conflict is an update, so
  the split has to be known before either rule can be applied — and it was
  neither: `create()` refused planting a row owned by somebody else and
  `upsertMany` planted it, `update()` refused writing to their row and
  `upsertMany` wrote it, and a `@@hasTemplates` template `updateMany` correctly
  skipped was written too (`FJS-720`). The presence lookup a logged model
  already pays for is now paid whenever the model has policies; the insert half
  calls `checkCreatePolicy` and refuses the batch WHOLE, like `createMany`; the
  update half rides SQLite's own `ON CONFLICT … DO UPDATE … WHERE`, where an
  unqualified column is the EXISTING row, and narrows rather than throwing —
  because that is what `updateMany` beside it does. `count` counts what SQLite
  moved rather than what the caller handed in, or a guarded skip reports as a
  write.
- **A bulk write prepares one statement per row SHAPE, and the shapes come from
  the rows.** `createMany`/`upsertMany` no longer take the column list from row
  0, so a batch may be ragged; rows still insert in caller order, because an
  autoincrement id is assigned in insert order. What a row does NOT carry, it
  does not write — the column takes its DDL default.
- **A key set to `undefined` is dropped from a write payload.** Only `null`
  clears (Invariant 9). `{ views: form.views }` off a form with no views field
  used to bind NULL and defeat the column's default.
- **An enum array has no CHECK behind it.** `targets ReclaimTarget[]` is a JSON
  TEXT column; SQLite cannot read a JSON array's elements without `json_each`,
  and a CHECK may not contain the subquery that would take. Membership is
  enforced at the client boundary only — the same tier as `@minItems` and
  `Int[]` element typing. Raw SQL writes anything.
- **A soft-deleted row KEEPS its `@unique` values, and every write path says so
  the same way.** Ruled rather than fixed: freeing the slot makes `@unique`
  false for any read that includes deleted rows — `findUnique(withDeleted)`
  would legitimately match two — and makes `restore()` conditionally
  impossible, which is the whole contract. SQLite also cannot make an inline
  `UNIQUE` partial, so the alternative rebuilds every affected table.
  `SoftDeletedUniqueError` (409) names the field, the value and the holding
  row; releasing a slot is deliberate — `update({ …, withDeleted: true })` to
  move the value, `delete({ …, withDeleted: true })` to stop keeping the row
  (`FJS-204`, `DECISIONS.md` § Query & write semantics). **The four write paths
  gave four answers before, two silently** (`FJS-278`): `upsert` returned `null`
  having written nothing, because its race-recovery fallback assumes a UNIQUE
  conflict means a LIVE row appeared and retried as an `update` that filtered
  the deleted row; `upsertMany` is `ON CONFLICT DO UPDATE`, which SQLite
  resolves knowing nothing about soft delete, so the write landed IN the deleted
  row and reported success. A new write path that can hit the constraint routes
  through `asSoftDeletedConflict`, which only runs on the failing path.
- **`@@hasTemplates` and `@@softDelete` are the same two flags on every method,
  reads and writes alike** — `withTemplates`/`onlyTemplates`,
  `withDeleted`/`onlyDeleted`. Neither is an access rule, so **`asSystem()` does
  not lift either**; the flags are the only way past. They part company in one
  place: a hard `delete`/`deleteMany` bypasses the soft-delete filter by design
  (it is the purge hatch, and exists beside `remove` for that), while the
  template filter applies to it — a template is a live row in a parallel
  category, and destroying rows no read of the model returns is data loss the
  caller cannot anticipate (`FJS-176`). `restore()` is soft delete's way back;
  a template's is `update({ isTemplate: false, withTemplates: true })`.
- **A write cannot return a `@from` field from `RETURNING`** — SQLite takes no
  correlated subquery there. `create`/`update`/`upsert`/`remove` re-read them
  (`hydrateFromFields`, one extra SELECT, only when the model declares `@from`);
  `delete` reads them on its pre-DELETE SELECT, the last moment they correlate.
  A new write path must opt in with `read(row, { hydrateFrom: true })` or it
  silently reintroduces the bug.
- **A `@values` binding is checked through the CALLER'S accessor, and that is the
  whole of its permission story.** `enforceValueSets` reads the source model off
  `ctx.tables[accessor]` — the sibling at this client's own flavor — so the set
  a caller sees is the set their own `@@allow` shows them, and `open` creates
  through that same accessor, which means the source model's `@@gate` and
  `@@allow` answer who may extend it. Written against `asSystem()` it would
  offer every row to everybody and let any caller grow a shared list, and it
  would pass every test that uses one principal. **`suggested` issues no query
  at all** — enforcing nothing has to cost nothing, or nobody uses the strength
  that keeps the list traveling. **Six write paths carry a payload and all six
  call it**; `test/valuesets.test.ts` § every write path derives that list from
  `client.js` itself rather than restating it, because a seventh added later
  would be silent.
- **`@updatedAt` is stamped by the CLIENT, and there is no trigger any more.** It was an AFTER UPDATE trigger, and a trigger can only ever read SQLite's own clock — so `createClient({ now })` moved a policy's `now()` and left every stamp on today, which meant the one thing a frozen clock is for (staging a row aging past a window) could not be staged (`FJS-531`). Three mechanisms became one: `@default(now())` and `@updatedAt`-on-create go through `buildGeneratedDefaultMap`, `@updatedAt`-on-update through `stampSets`, all three reading the client's clock. `isUpdatedAtField` in `ddl.js` is the one answer to *is this a stamp column* — the ATTRIBUTE, or the name `updatedAt` on a `DateTime`, because binding to the attribute alone leaves a column named for the job unstamped. **`FJS-396` is closed at the root rather than narrowed**: RETURNING is evaluated before an AFTER trigger, so a write that leaned on one handed back a value the row no longer held, and naming the column in the SET clause only fixed that while the two values DIFFERED — which they do not when the clock has not moved between two writes to one row (under an injected clock, every write after the first). With no trigger there is no window. **The floor is now asymmetric and that is the price**: the column DEFAULT stays, so a raw INSERT still stamps; a raw UPDATE does not, and a hand-written statement owns its own stamp. An existing database is migrated by `litestone migrate` — pristine stops carrying the trigger, `droppedTriggers` in `migrate.js` sees it, one `DROP TRIGGER IF EXISTS` and no table rebuild. `@@external` answers no stamp columns at all: a client stamp into a table litestone does not own is a silent write into somebody else's.
- **Retention measures from the client's clock too.** `runSqliteRetention` and `compactJsonl` both took `Date.now()`, so `env.clock.advance('100d')` moved nothing either pass could see — the sweep is a crossing, and the clock could not stage the one thing it was reached for. One reading of the option (`nowMs` in `retention.js`) because both halves take it, and two interpretations is how the jsonl half ends up sweeping to a different instant than the SQLite half.
- **`$transaction` serializes per client, and re-entrancy is decided by the async
  context rather than by the depth counter.** One connection holds one
  transaction, so a second REQUEST arriving while the first awaits used to look
  exactly like a genuinely nested call: it took a SAVEPOINT inside the first
  request's transaction, was told it committed, and lost its rows when that
  request rolled back (`FJS-244`). A nested call inherits an `AsyncLocalStorage`
  store and still SAVEPOINTs; anything else waits on a FIFO lock. This only
  serializes what SQLite already does — two `BEGIN IMMEDIATE`s cannot overlap on
  one connection. `createMany`/`upsertMany` go through the same lock, awaiting the
  acquire while their batch body stays synchronous.
- **`$close()` finalizes the statement cache, and without that it closes
  nothing.** bun's `close()` is `sqlite3_close_v2` — it defers the real
  destruction until the last prepared statement is finalized — and `wrapDb`
  holds up to 500. Measured: a close with one live statement freed **0 file
  descriptors**, and finalizing that statement freed 3. So for its whole life
  `$close()` produced a client that answered a cached query off a closed,
  checkpointed handle and threw on a fresh one, and the tenant pool's eviction
  paid a 7.97 ms `wal_checkpoint(TRUNCATE)` for a release that never happened
  (`FJS-640`). Every path now throws `ClientClosedError` naming the file. The
  read side needs its own call: `conn.readDb` is REPLACED by the read router,
  so anything reaching for `conn.readDb.close()` is talking to the router and
  not to the wrapper it closes over.

## Events and the audit trail

- **A write event says whether it can name the row, and it says so in `scope`.**
  `row` is one row — `result` is it, or `null` where `select: false` skipped the
  RETURNING. `collection` is `count` rows matching `where`, from a statement that
  never built them. Do not read the discriminator off `result`: `result: null` is
  two different facts, and treating it as *no rows* is exactly what dropped every
  `select: false` write a layer up (`FJS-307`). Every one of the eleven write
  methods announces now — seven did not, `restore` and `delete` among them, both
  of which had their rows the whole time. `test/write-events.test.ts` is the grid
  and a new write path has to appear in it. **A write matching no rows announces
  nothing**: a count of zero sending every open tab back to the server is worse
  than saying nothing.
- **`announce` in the SCHEMA is the other axis — how far an announcement
  travels, not what shape it takes.** `database main { announce crossProcess }`
  (default `inProcess`) records each announced write in a table so every other
  process ON THIS MACHINE sharing the file hands it to its own `$tapEvents`
  subscribers, marked `foreign: true`, on the same seam — junction cannot tell
  the two apart (`FJS-D173`). Declared, because it costs **+14 µs on a 25 µs
  single-row insert** and nothing on a bulk one. The row carries the **id and
  never the row** — writing the row would put the plaintext of every
  `@encrypted` and `@guarded` column into a table beside the ciphertext — so the
  receiver re-reads, which means **the row arrives as it is NOW** rather than as
  it was when the event fired. Refused on a `jsonl`/`logger` driver by name.
  Two things it does not promise and both are stated: **one machine**, and
  **at-most-once across a crash**, since the row is recorded after the write's
  own transaction commits.
- **`announce` is the dial on a bulk write, and it is per CALL** — `collection`
  (default, one event, O(1), every list re-asks) · `rows` (one event per row, off
  `RETURNING`) · `none`. `createClient({ announce })` is the floor and a call
  beats it; an unknown value is refused by name before the statement runs.
  **Not decidable by size**: the count is unknowable before the write without a
  second query, so this is declared and never guessed — which is also why it is
  the CALL and not the model, since one model carries both a three-row cancel and
  a two-million-row purge. `rows` is ANDed with the audience, so an app that opts
  in and has nobody listening still takes no `RETURNING`. A logged model already
  takes one, so there it is free. **An announced bulk row goes through `read()`**
  — straight off `RETURNING` it still carries `@guarded` and `@encrypted`
  columns, which every other event path strips. `announceBulk` is the one owner
  of the three-way branch for that reason.
- **The audit logger defers one event-loop tick** — `fireLog()` writes via
  `setImmediate`, then the jsonl driver appends synchronously. A read in the same
  tick sees 0 rows and the `.jsonl` may not exist yet; anything after an `await`
  sees the row. Yield once rather than waiting: there is no timed buffer, and no
  flush on exit to wait for. **The swallow has to be on the PROMISE**: every
  driver's `create` is `async`, so the `try`/`catch` that was around the call
  caught nothing and a failed audit write became an unhandled rejection rather
  than the dropped row it is documented to be. It could not be seen while the
  index had a five-second wait; `busyTimeout: { audit: 0 }` makes it every time.
  Dropped but not silent — the first loss per model warns, once, because whatever
  produces one produces thousands.
- **A jsonl/logger retention pass reads the FIRST line and stops if it is inside the window.** An append-only log is oldest-first, so a fresh first line means every line is fresh — the right optimization for a check that runs on every boot over a file that grows for the life of the deployment. What it costs is a probe: append an old row to the END and the pass returns `null`, having read nothing, so `$retain()` answers `[]` and the job that called it reports success while removing nothing. A test planting an old row has to plant it where an old row would actually be. The companion `.index.db` holds byte offsets and is DELETED by a compaction that rewrites the file, then rebuilt lazily — so anything rewriting that file by hand owes the same removal.
- **Protected fields are redacted.** Any `@encrypted` / `@guarded` / `@secret` field has its value replaced with `'[redacted]'` in both the field-level entry and the model-level `before`/`after` snapshot — the trail records *that* the field was written, never what it holds. This is what makes `@secret`'s expansion safe: `@secret` implies `@log(<first logger db>)`, so declaring a logger database alone starts logging every `@secret` field, and without redaction that writes plaintext beside a correctly-encrypted row. `null` is preserved rather than redacted (nothing to leak, and it keeps `null → value` transitions visible); unprotected fields on the same model are still logged in full; the row returned to the caller is untouched.

## Policies

- **A row policy has TWO implementations and they can disagree** — the entries
  below say where. `verifyRowPolicies` grades one against the other, which is
  a real oracle rather than a restatement. `create` is not covered because
  `evalJs` is its only implementation, and grading it with `evalJs` is circular.
- **Rows on one side of a predicate prove nothing.** A policy that admits
  everything and a policy that is not applied at all are the same observation.
  Reported as `error`, never as a pass.
- **A row policy is compiled twice, into two languages, and they can disagree.**
  `read`/`update` become a WHERE (`compileSql`); `create` and the post-update
  check are evaluated in JS (`evalJs`). Every comparison form has to be handled
  in both — `field == null` was in neither and fell to `"col" = NULL`, so create
  allowed a row that read then hid (`FJS-195`). Adding a form to one half is
  half a change. **An encrypted column is where the two halves legitimately
  differ**: the WHERE encodes its operand (`comparisonEncoderFor`, the same
  rewrite a `where` gets, `FJS-214`), the JS evaluator compares plaintext
  because `create` hands it the data as written. `post-update` gets the row read
  BACK, where the column is stripped by `@guarded` — refused at startup
  rather than denying every write. **`test/policy-interpreters.test.ts` is the
  oracle between them** — the same predicate over the same rows, asked of both
  halves, 29 forms × 3 principals × 5 rows plus the clock, a `check()`
  delegation and a `@@deny` beside an `@@allow`. Adding a form to the parser
  means adding a row there, or the two compilers can take it in different
  directions with nothing failing.
- **The JS half compares the way SQLite does, and `===` is not that.** SQLite
  applies the COLUMN's affinity to the other operand and then orders by storage
  class; JS does neither, so `ownerId == auth().id` over an `Int` column and a
  caller whose id is the string `'5'` — which is every junction principal, a
  `SessionContext` carrying `userId` as TEXT — was TRUE through a query and
  FALSE on create and in `$readAs` (`FJS-713`). Measured across column type ×
  operator × operand, **54 of 594 cells disagreed**, in both directions and on
  every operator, so the filed pairing was one of a class. `compare()` in
  `policy.js` now puts a JS value in the storage class the binder would have
  given it (a boolean is 0/1, a `Date` its ISO text), applies the column's
  affinity, and orders by class; `in` takes the same affinity per element. Two
  things are deliberately left alone: a value that is neither a number nor a
  string after all that keeps JavaScript's answer, because two distinct Buffers
  rank EQUAL under a class comparison and `==` would answer TRUE for them; and
  the affinity is read through `sqlType`, the DDL emitter's own function, so it
  cannot drift from the column that gets built.
- **The create half is evaluated against the PAYLOAD, so a column SQLite
  computes from the row can never be named in a create policy.** `@derived`,
  `@generated` and `@from` read `undefined` there, so the allow never holds and
  the model is uncreatable by everybody — while the read half, being SQL,
  answers it perfectly (`FJS-719`). Refused at build, and derived from the FACET
  rather than from a list, because the enumeration that already refused
  `@computed` and `@transient` is what missed these three. `@system` is
  deliberately not in it: `system: ['col']` puts one in the payload, so a create
  policy naming one is answerable. A `@@deny` fails the opposite way and gets
  the opposite sentence — an allow that never holds refuses everybody, a deny
  that never fires refuses nobody.

### The expression language

```
auth()                    — current auth object (null if unauthenticated)
auth().field              — field on auth object
auth().level              — the level the gate grades the caller at for THIS
                            model — `getLevel(auth, model)`, carried by no
                            principal, so `ownerId == auth().id || auth().level >= 5`
                            is *the owner or an administrator* in the app's own
                            terms, in a query and a broadcast alike (FJS-D296).
                            A schema naming it installs the gate; an @@auth
                            column named `level` beside it is refused
auth() != null            — authenticated check
now()                     — current UTC timestamp
check(field)              — delegates to the related model's ROW POLICY and to
                            nothing else. A parent held only by a @@gate or a
                            capability grid delegates as unrestricted — both are
                            enforced a tier above any compiled predicate — so
                            createClient warns, naming what the parent is
                            actually protected by. A cycle (a mutual pair, or a
                            self-relation checking its own parent) is REFUSED
                            there: it compiles to a predicate no row satisfies,
                            which admits only rows whose FK is NULL and reads
                            like a filter working (`FJS-636`).
field == value  field != value  field > value  field >= value  field < value  field <= value
value in list             — membership. The list is ALWAYS the right operand:
                            `auth().id in memberIds` (an array column),
                            `ownerId in auth().teamIds` (a list on the principal),
                            `status in ['draft', 'review']` (written literally).
                            An array column compiles to the json_each EXISTS a
                            `where: { col: { has } }` produces; the other two to
                            `IN (?, …)`, and an empty list admits nothing.
                            What the schema can refuse is refused at startup
cond ? a : b              — a value chosen by a condition. Looser than `||` and
                            RIGHT-associative, so `a ? x : b ? y : z` nests into
                            the else. A parenthesized group is an operand on
                            either side of a comparison. In BOTH compilers —
                            CASE WHEN in SQL, `?:` in JS
expr1 && expr2  expr1 || expr2  !expr
```

### What `auth().x` may name

Refused at client build unless the claim is one of five things (`FJS-666`, ruled
`FJS-D181`):

  the framework's nine    `id` · `capabilities` · the six `FrontierGateGetLevel`
                          reads — `role` `isAdmin` `isOwner` `isSystemAdmin`
                          `verifiedAt` `activatedAt` — and `level`, the grade
                          itself. A standing is not a column
  the `@@auth` model      its own field names, which is what `sessionFields` carries
  `tenancy { claim }`     the tenant claim
  a top-level `claim`     a name the app resolves per request — `claim cartToken`;
                          with `from`, a value read per request off the row
                          pointing at the caller — `claim siteId from
                          Employee(userId).siteId` — so a role held on another
                          model needs no resolver. `db.$claimsFor(p)` is the read
  `createClient({ claims })`  the same names, stated in code

**It grades only when there is a set.** No `@@auth` and no `claims:` means
nothing to compare against, and that silence is announced once per distinct set
of names rather than assumed. `claims: []` is a statement; absent is silence.

**An absent claim is UNKNOWN and both interpreters read it that way** (`FJS-668`):
an `@@allow` holds only on TRUE, an `@@deny` fires on TRUE and UNKNOWN alike,
which is `(allows) AND NOT (denies)` on both sides. `x == null` is exempt and
answers a boolean — that is how the language spells `IS NULL`, and it is the
only way to write *the caller carries no such claim*.

### Encryption keys

A stored value names its key: `v2.<kid>.<payload>`, kid = a domain-separated
HMAC of the key truncated to 8 hex (`FJS-714`, ruled `FJS-D183`). An unknown kid
still tries the ring — GCM's tag is the authority, the kid is only the order.

`createClient({ previousEncryptionKeys: [...] })` is a READ-only ring. The old
key stays on it after `$rotateKey`, so a rotation that crashed between two
databases (it is one transaction PER DATABASE) is readable and resumable.

Three traps, all closed and all worth knowing:

  the operand is widened  a deterministic encoding is a function of the KEY, so
                          a filter is encoded under every key on the ring — else
                          a not-yet-rotated row silently matches nothing
  the v1 twin is emitted  the payload is BYTE-IDENTICAL across versions, so a
                          pre-upgrade `v1d.<p>` would not match `v2d.<kid>.<p>`.
                          No suite here can see this: they all build a fresh db
  a caller sends none     a ciphertext-shaped value from a non-system caller is
                          refused by name (`FJS-715`); a system write may carry
                          one and it is skipped only where it VERIFIES

A decrypt that fails **raises** (`FJS-716`). The one column that degrades is
`@secret(rotate: false)` — a loss the schema declares.

## Schema, parse and imports

- **Anything that loads a schema from a PATH loads it with `parseFile`, never
  `parse`.** A schema may `import "./other.lite"`, and only `parseFile` resolves
  that. Three readers had it wrong and each failed differently, all silently
  (`FJS-264`): the CLI read the root file for every command, so `db push`
  reported *already in sync* while three tables were never created; sierra's
  build handed the browser a `$defs` table with the imported models missing, so
  `createResource` degraded to a bare `make()` and a generated `<Form>` rendered
  nothing; and **`createTestEnv` graded a partial schema and passed** — a green
  `verifyGateLadder` over models it never saw, which is the worst of the three
  because it is the thing that exists to catch the other two.
- **`parse` is for TEXT with no file behind it** — an editor buffer, a git blob —
  and there the caller owes the imports. `inlineImports` / `inlineImportsFromDisk`
  in `parser.js` are the one owner of following an import line as text; reading
  and resolving are the caller's, because a git ref is addressed with posix paths
  through `git show` and a file on disk is not. Two callers: `release`'s baseline,
  which inlines **at the ref** (from the working tree it would compare the
  previous release's root schema against today's imported models and call every
  one unchanged), and `createTestEnv`, which needs ONE text because that text is
  the template cache key — keyed on the root file alone, editing an imported file
  reuses the previous run's database.
- **An import specifier is a path OR a package.** Relative and absolute are
  resolved against the importing file; anything else goes through node, so the
  package's own `exports` decides what is importable and nothing guesses at a
  path inside one. That is what lets a package SHIP a schema fragment
  (`import "@frontierjs/auth/schema.lite"`) instead of every app keeping a copy a
  package upgrade cannot reach (`FJS-265`). The failure message names both causes
  — not installed, or not exported — **always**, because node distinguishes them
  and bun collapses both into `MODULE_NOT_FOUND`; branching on the code makes the
  error depend on which runtime read the schema.
- **`import "..." into <db>` is how the importing app says where.** A shipped
  fragment has to spell some database name and only the app knows what its own are
  called, so `into` is the one parameter that varies. One rule, stated twice: the
  NEAREST statement wins — an inner `into` on a nested import beats an outer one,
  and any `into` beats a `@@db` written in the imported file. A model naming no
  database gets one. Importing one file twice under two different `into`s is an
  ERROR, not a precedence puzzle: it is merged once, so only one could hold.
- **`parse` and `parseFile` answer the same shape.** `parseFile` used to let a
  `ParseError` throw where `parse` returned `{valid: false, errors}`, so every
  caller that warns and keeps going — the CLI's error box, sierra's build, which
  is meant to leave the app running on explicitly-passed schemas — got a stack
  trace the moment a schema had a typo. An error in an imported file names that
  file, since imports chain.
- **`encryptionKey` is parsed as hex**, so a 64-*character* key is not necessarily
  a 32-byte one.

## DDL and migrations

- **There are THREE schemas and most migration confusion is a comparison between the wrong two** — declared (`schema.lite`), shadow (the migration files replayed into an empty database) and live. `migrate create` and `migrate check` compare declared ↔ shadow: *what migration is missing*. `migrate dev` and `migrate baseline` also compare shadow ↔ live: *has somebody changed this database without writing a file*. It was ONE comparison, declared ↔ live, doing both jobs — which is why a `db push` database, matching the declaration by construction, made `migrate create` answer *already in sync* at the exact moment a migration was needed, while the deploy refused for want of one (`FJS-388`, ruled `FJS-D123`). `buildShadow` and `historyGap` in `core/migrations.js` are the owners; `migrate check` is the repo-only question with no database opened, and `fli deploy:doctor` asks it before an image is built while `migrate apply` asks the same function at container start. **`db push` is prototyping only** — it reaches no deploy — and `migrate baseline` is the way back for a database that is already correct and has no history to say so, refusing when the database does not actually hold what the files build.
- **A partial unique is named `uniq_<table>_<cols>` and an `@@index` is named
  `idx_<table>_<cols>`, and they are two name spaces on purpose** (`FJS-614`).
  One derivation made `@@index([a])` and `@@unique([a], where: …)` collide, and
  the refusal's two ways out — different columns, one predicate covering both —
  do not exist for that pair, because they are different KINDS of thing about
  one column: the ordinary lookup, and *at most one row where the predicate
  holds*. Dropping the plain index is not the answer either, since a partial
  unique covers only the rows its predicate admits — the same reason `advise`
  does not count one as foreign-key coverage.
  **The prefix IS the ownership test** in `migrate.js`, so `ownedIndex` reads
  both or litestone stops dropping its own index.
  **A database written before the split needs the RENAME, and the cost of not
  doing it is silent**: the model's own `@@index` over those columns is then a
  `CREATE INDEX IF NOT EXISTS` against a name already taken by the unique one,
  which SQLite answers by doing nothing at all. So a matched pair whose NAMES
  differ is one DROP and one CREATE, no rebuild. **The name is deliberately not
  part of `indexKey`** — a hand-made index of the same shape under another name
  matches today and is left alone, and keying on the name would make it foreign
  AND create litestone's beside it, so the database would carry two identical
  indexes and pay for both on every write.
- **A partial unique's predicate has its literals INLINED, and an index's may not
  have any.** SQLite refuses a bound parameter in a partial index predicate
  whichever kind it is — `parameters prohibited in partial index WHERE clauses`,
  raised at migration time — and this compiler binds every value. The index form
  refuses a value comparison at parse for a different reason (the planner cannot
  prove a query implies it), so the two rules look like one and are not:
  `predicateToLite`'s `{ values: true }` is asked for on the unique path alone,
  because emitting a value comparison as `@@index(where:)` writes a `.lite` this
  parser refuses (`FJS-594`).
- **A generated column is not in `PRAGMA table_info`, and a diff built on it is
  blind in both directions.** `introspect()` reads `table_xinfo` for that reason
  — `hidden` 2 = VIRTUAL, 3 = STORED — and the expression comes off the table's
  own `CREATE` statement, the only place SQLite keeps it. The pragma decides
  WHETHER a column is generated and the text parse only supplies the expression,
  so a parse miss cannot invent one. Three shapes follow from SQLite and none of
  them is a choice: a STORED add is a rebuild (`cannot add a STORED column` on a
  populated table), a VIRTUAL add is an `ADD COLUMN` **that has to carry its
  `GENERATED ALWAYS AS` clause** — without it the ALTER applies cleanly and
  leaves a plain writable column of the same name — and a rebuild must leave the
  column out of its `INSERT … SELECT` entirely (`cannot INSERT into generated
  column`), which loses nothing because the new table computes it.

- **A column that LEAVES the schema is refused by `autoMigrate`, because a rename
  is a drop plus an add.** `diffColumns` has no rename detection, so
  `body` → `content` is a drop and an add, the rebuild copies only what the two
  tables share, and the values went — `state: 'migrated'`, with the row-count
  guard passing because it counts rows and not values (`FJS-641`). A plain drop
  was exactly as silent, which is why the rule is *any column drop* rather than
  the rename-shaped case. `{ acceptDataLoss: true }` is the escape — Prisma's
  `--accept-data-loss` on the mechanism this is modeled on — and the hash is
  withheld like the other blocked rules, so it re-announces on every boot. One
  column out and one in of the same type is reported as a probable rename with
  the `ALTER TABLE … RENAME COLUMN` to use instead; that guess changes the
  SENTENCE and never the decision, so being wrong costs a reader nothing. **The
  file path still applies** and gets a boxed DESTRUCTIVE banner instead: the
  file IS the review step, which is the whole difference between the two.
- **A rebuild SQLite refuses answers `state: 'failed'` rather than throwing.**
  A STRICT table takes no TEXT into an INTEGER column, so `String` → `Int` over a
  populated table threw `cannot store TEXT value in INTEGER column
  post__new.body` out of the migrator — at boot, naming a table that exists only
  inside the migration it died in (`FJS-645`). The transaction had already
  rolled back either way, so what was missing was the vocabulary. `failed` is a
  third state and honestly distinct from `blocked`: one is a pre-flight refusal,
  the other is SQLite declining what was attempted. A view the rebuild
  invalidates is `failed` too, where it used to throw.
- **A migration only drops what litestone named.** Triggers: `*_fts_*`,
  `*_updatedAt`. Indexes: `idx_<table>_<fields>`. Anything the app created
  survives an ordinary migration — `introspect()` reads triggers into
  `__triggers` and a rebuilt table has its generated triggers restated, because
  a rebuild drops the table and its triggers with it. **A rebuild destroys an
  app-created trigger or index and litestone does not support carrying one
  through** (ruled, `FJS-183`); the generated migration names what it is about
  to destroy, and `autoMigrate` applies that SQL without showing it.
- **A view over a rebuilt table IS carried through** — dropped before, restated
  verbatim after, schema-declared and hand-made alike; left in place it takes
  the migration down, because `ALTER TABLE … RENAME` reparses every view. Each
  restored view is then read once inside the transaction, so one the rebuild
  invalidated refuses the migration instead of surviving broken. Not catchable
  when the body double-quotes the column — SQLite reads `"scratch"` as a string
  literal and reports nothing.

## SQLite and the engine

- **`busy_timeout` is 5000ms on every connection this package opens, and it is a CROSS-PROCESS device only.** `src/core/pragmas.js` is the one owner — the number was a literal in three files and absent from four others, so whether a database waited under contention was an accident of which file opened it (`FJS-569`). The one with no wait was the `logger` index, which is schema-global and therefore the single file every tenant and every process writes; a second API beside a running one died on its first audit write, in about a millisecond. **Inside one process the timeout is not a safety net, it is a stall** — `bun:sqlite` is synchronous, so a connection waiting on the lock blocks the event loop, and it can deadlock outright: the waiter blocks the loop, the holder's continuation never runs to commit, and the wait can only expire. Measured both ways — 5000ms then failure in one process for an 800ms hold, 1444ms then commit across two. What makes the in-process case fine is `$transaction`'s FIFO lock, which queues two transactions on one client in JavaScript so they never reach the SQLite lock — and what keeps THAT true is **one client per database file per process**, since `createClient` twice on one path is two connections that can deadlock where `$setAuth`/`asSystem`/`$scopedBy` are views over one handle. **The number is `createClient({ busyTimeout })`, precedence option → env (`LITESTONE_BUSY_TIMEOUT`) → 5000**, per database as `{ default, <db> }` because the audit index wants the opposite answer to main — its write is fire-and-forget and its failure swallowed, so `{ audit: 250 }` says *drop the row rather than stall the loop*. A malformed value and a key naming a database the schema does not declare are both refused by name at `createClient`, since a dropped key is a database silently keeping the default. **There is deliberately no `database { }` spelling** (`FJS-D155`): how long to wait for another process is a fact about THIS process, and the same schema is opened by an API answering a person and a queue draining a batch. `docs/concurrency.md` is the whole of it, including the worker-thread answer for a query that is genuinely long — measured, a worker holding the lock for 600ms let the main loop keep ticking and the main thread's write waited 639ms and committed, where the same shape on one thread deadlocks.
- **`@big` has two traps in its implementation, both measured.** `safeIntegers` is per-STATEMENT and all-or-nothing, so a wide model's statements answer BigInts for `id`, a count and a Boolean's 0/1 as well — and asking at the statement while narrowing in `read`/`readAll` is an enumeration: `count()` answered `0n`, because a statement also serves counts and aggregates that reach a caller through neither. The **statement** narrows what it returns (`wideStmt`/`wideDb` in `client.js`), and `wideDb` unwraps through `$plain` before re-wrapping, because a wide model's `readDb` is handed to the include and `@from` resolvers, which read a DIFFERENT model. For a key the row read does not recognize — `_max__col`, a window's row number — the fallback is the VALUE: one that fits becomes a number, one that does not becomes digits.
- **A plain object in `bun:sqlite`'s parameter list voids every positional binding in that statement.** It is read as a named-parameter bag, and a statement built with `?` matches none of its keys — so nothing is bound, including the WHERE, and no error is raised. `SELECT ? IS NULL` passed `{x:1}` answers 1; `UPDATE t SET a = ? WHERE id = ?` passed `({x:1}, 1)` changes no rows, because the id was voided along with the value. Every symptom of FJS-199 is this one fact wearing different clothes. Anything that reaches `run`/`query`/`prepare` with a caller-supplied value has to know the value is a bindable primitive first.

## Tenancy

Row tenancy desugaring into `@@deny` is the `data-hazards` skill's. What
follows is the registry and the column.

**`maxOpen` is how many tenants to keep WARM, not a ceiling** (`FJS-D172`).
Eviction never closes a client it lent out — `get()` hands one to a request that
holds it across every await it makes, and closing it left a MIXED client rather
than a dead one. `retain(id)` is what makes an eviction able to close anything:
junction's `withTenantDb` pins for the length of a request, so a client whose
every lease has ended closes at the next eviction, and one from a bare `get()`
is dropped for bun's finalizer instead. A fan-out inserts COLD into a ring, so
an admin dashboard does not evict the tenants being served.


**And it takes the UNIQUES.** The deny guards reads; a `@unique` guards writes,
and on a scoped model a bare one was unique across the whole installation — two
tenants unable to both hold `launch`, the second refused by a message naming a
value it may not read (`FJS-1159`). The tenant column is PREPENDED, which is also
the prefix every read under row tenancy filters on first, and a field-level
`@unique` is lifted to a table constraint because a column cannot carry a
two-column UNIQUE. `@unique(global)` / `@@unique([…], global: true)` is the
opt-out and existed before this, which is why the change costs no new word.
**Only where the model carries the column** — one scoped through a PARENT has
none, and which parent to scope by is not decidable when a model has two, so
those keep the warning. Both halves are announced, since `name String @unique`
now builds an index over two columns and the line cannot show it;
`db/ddl.snapshot.sql` is the artefact.

**A stamped column is `readOnly` in the generated JSON Schema**, with
`x-litestone-kind: 'tenancy'` — `@system`'s treatment for `@system`'s reason:
the application writes it and the caller does not. Being out of create-mode
`required` was NOT enough on its own, and the way that failed is worth keeping
in mind for any server-written column. `make()` seeds every WRITABLE column,
sierra's `normalizeBlanks` rewrites a blank to `null`, and a stated null is a
VALUE rather than an absence — so the `@default(auth().<claim>)` never applied
and the write came back `400 must be a string` (`FJS-387`). A column nothing may
send has to stop being OFFERED, not just stop being demanded.

`@@tenant(none)` marks a model that spans tenants; `@@tenant(column: "x")` names
a different column. Models declaring neither are reported by name, once, at
parse. `jsonl`/`logger` models are never scoped — no policy engine there — and
those databases stay schema-global under `strategy database` too.

`registry.tenantFor({ host, headers, principal })` applies the declared
`resolve`; Junction's `createApp({ tenants })` calls exactly that rather than
carrying a second reading of it.

## Client utilities

What each `$`-method on a client answers, and why it exists.

```js
db.$backup('./backups/prod.db')
db.$backup('./backups/prod.db', { vacuum: true })
db.$transaction(async (tx) => { ... })
db.$inTransaction         // is one open on this connection right now? Same answer
                          // on every flavor — one write connection, one counter.
                          // For a write whose meaning depends on rolling back
                          // with everything else (junction's outbox row)
db.$attach('./other.db', 'other')
db.$detach('other')
db.$rotateKey(newKey)      // re-encrypt all @secret(rotate: true) fields; returns per-model stats
await db.$audit({ operation: 'login.failed', model: 'User', records: [id],
                 actorId: id, meta: { reason: 'bad-password' } })
                           // the ONE owner of putting a row in the audit trail.
                           // For what @@log(audit) cannot see: an event that
                           // performs no write, or one whose asSystem() write
                           // names no actor. THROWS — unlike @@log, the record
                           // is what the caller asked for. actorId defaults to
                           // this client's principal; a system context has none.
db.$capabilitiesFor(user)
                           // { held, unknown, byModel } — what can this person do.
                           // Fourth sibling of the three above and the same
                           // contract: takes its subject as an ARGUMENT, and every
                           // flavor answers identically for the same one. `unknown`
                           // is the half that earns it — a capability is a
                           // reference, so a rename leaves the OLD string sitting in
                           // every Role row; this is what shows you the data
                           // migration that did not run. Accepts a principal or the
                           // bare list, since the union of somebody's roles exists
                           // before a principal does
db.$readAs('order', row, principal)
                           // the row as that principal would have read it, or
                           // null. FIFTH sibling, and the one that exists
                           // because a BROADCAST IS NOT A SELECT: @@allow
                           // compiles into a WHERE, so a row reaching a caller
                           // through a query is filtered by construction and
                           // one reaching them through a WS frame was filtered
                           // by nothing (FJS-631). Gate, then row policy, then
                           // that principal's own field policies. No query —
                           // the row is in hand, so a @from/@computed on it is
                           // the writer's. Fails closed: an undecidable policy
                           // throws and a throw refuses
db.$readGrading('product') // 'open' | 'graded' — whether $readAs can ever
                           // answer anything but the row it was given. Gate 0,
                           // no read policy, no field policy → open, so a
                           // catalog costs nothing. An UNKNOWN accessor is
                           // 'graded': the other siblings answer {} because
                           // *I cannot judge this* is not *this is wrong*, and
                           // here it is a permission, so it falls the other way
db.$levelOf('order')       // the level THIS client's principal is graded at for
                           // Order — the app's own getLevel(auth, model), asked
                           // rather than re-derived (FJS-D308). SEVENTH sibling,
                           // and the one that takes its subject OPTIONALLY: the
                           // common caller holds the scoped client of the caller
                           // it is asking about, which is what picks up the
                           // gate's per-request cache. $levelOf('order', who)
                           // grades somebody else, as $readAs does. Per MODEL,
                           // because getLevel is; an accessor naming no model
                           // grades with a null model. `null` means *I cannot
                           // grade* — no @@gate means no plugin — and never a
                           // level: junction's method gate and its gate-mode
                           // broadcast grading fall back to the shipped grader
                           // there, which is what such a schema auto-installs
db.$protectedFields('secret')
                           // { data: 'encrypted' } — which columns must never be
                           // written down in plain text, and which protection
                           // each carries ('guarded' | 'encrypted' | 'hashed').
                           // For an APPLICATION keeping a trail of its own:
                           // @@log(audit) redacts these in its own JSONL, and an
                           // app writing its own audit table had nothing to ask.
                           // Same contract as $checkWhere — unknown accessor is
                           // {}, every flavor of client answers the same
db.$softDelete             // { ModelName: boolean } — which models hide a removed
                           // row rather than destroying it. A COPY, and on every
                           // flavor of client: the live map is what every read
                           // filters against, and junction holds a $setAuth one
db.$commitments            // [{ model, accessor, transition }] — every declared
                           // @@commitment; what junction's commitments() sweep
                           // walks. A fresh array, on every flavor
db.$schema                 // parsed schema object
db.$plugins                // installed plugin names, in run order — every client
                           // flavor. A gated schema auto-installs GatePlugin, so
                           // what you passed is not necessarily what is running
db.$rawDbs                 // { main: Database, ... } raw write connections
db.$databases              // { main: { driver, path }, ... }
db.$close()
db.sql`SELECT * FROM user WHERE id = ${1}`
                           // raw read. On a schema declaring access rules
                           // (@@gate/@@allow/@guarded/@scoped) this THROWS —
                           // raw SQL enforces none of them. Use
                           // db.asSystem().sql`...` to bypass deliberately, or
                           // where: { $raw: sql`...` } to keep the policies.
```

## Tooling and testing

- **The console's standing is only as true as its resolver, and the default is
  usually the wrong one.** `litestone repl --as <who>` grades with
  `FrontierGateGetLevel` unless `--gate <path[#export]>` points at the app's own.
  Measured on `example`: the default grades `ops@acme.test` at **3 (CREATOR)**
  and the app's `shopGateLevel` grades the same row at **4 (USER)** — and `Order`
  is `@@gate("0.4.4.5")`, so a create is refused in the console and permitted in
  the app. A console that is *approximately* somebody's session is worse than
  none, because you act on what it shows you, so the banner names which resolver
  answered. Related: a `--level` standing has **no `auth()`**, so every
  `auth().id ==` row policy matches nothing and its model answers an empty list
  rather than refusing — indistinguishable from a gate refusal by the result, and
  said out loud for that reason.
- **A REPL that does not serialize its lines executes them out of order, and
  `rl.pause()` does not fix it.** Pausing does not hold back lines readline has
  already buffered, so a pasted block or a piped heredoc fires every handler and
  the statements complete in whatever order their awaits finish — against a
  database, writes landing in an order nobody wrote. A promise chain is the fix
  and `close` has to await it too, or the session reports over with a write in
  flight. Both shapes are pinned in `test/repl.test.ts`, verified by breaking it.
- **One comparison, two gradings, and they are close to inverted.** `release.js`
  walks two release surfaces once; `classifyPivot` grades *can N-1 and N serve
  one database* and `classifyAccess` grades *who may now do more*. They disagree
  by construction — removing a `@@gate` is an `expand` and the widest thing a
  schema change can do — and on the five-part widening in `test/release.test.ts`
  **every widening is an expand**. A new comparison belongs in the existing walk
  with a direction attached, never in a second traversal: two walks over one set
  of declarations is how two answers to one question drift apart. The finding a
  field-level `@allow` was missing from the surface entirely came out of building
  the second grading, which is the argument.
- **A `@values` binding is on the deploy axis and not the access one.** It
  narrows by VALUE, identically for every caller, so `classifyAccess` says
  nothing about it — but a column gaining `@values(X)` starts refusing writes
  N-1 has been making all along, with no column, no type and no constraint
  moving, which nothing else in the surface can see. The three strengths are not
  a ladder: only `required` refuses, so `suggested` → `open` is an expand and
  anything → `required` is the pivot. The SET is carried separately from the
  binding because narrowing one narrows every column bound to it, and that is
  unreadable from any single field's row — and a set narrowed where nothing
  binds it as `required` is an expand, since a picker offering less refuses
  nothing.
- **A snapshot that carries a verdict cannot be rechecked.** `release.snapshot.md`
  holds the release surface and never the classification, because a verdict is a
  fact about two schemas while the file describes one — write it in and the file
  depends on its own previous contents, which is not a fixed point. Same reason
  `repo-report.snapshot.html` carries no dates and no timings. `--check` is
  therefore staleness alone, and the classification is printed.
- **A generated expectation must not come from the code it grades.**
  `expectedVerdict()` in `access.js` restates what `@@gate` means and does not
  call `levelPasses()` in the gate plugin, which is the opposite of the rule
  everywhere else here. It is not an oversight: when `gateLadder` asked the
  plugin, deleting a branch from the plugin produced **zero** mismatches across
  333 executed assertions. One exhaustive test over every (required × level) pair
  holds the two statements together. Describing the gate (the access snapshot)
  shares the predicate; grading it may not.
- **A mutation score that counts its own harness failures is worthless.** Only a
  verdict disagreement kills a mutant. Counting the `error` and `skipped`
  outcomes was worth 36 points on a 14-mutant schema: every mutant came back with
  the same 22 error rows and the score read 93% while four mutations went
  completely unnoticed. Same rule as the gate matrix, one level up.
- **The same rule one level up again: a mutant refused by the LOADER counts as a
  kill, and only while the ORIGINAL builds.** A schema the framework will not
  load cannot ship, so refusing it is a real kill — but nothing checked that the
  original loads, and on basecamp it does not: it declares `@secret`, so
  `createTestEnv` wants a key, so every mutant was refused and the run printed
  `100% killed · 14/14` having graded nothing (`FJS-597`). `mutationScore` builds
  the original first now and refuses with the reason attached. A thing that
  always passes and a thing that never ran are the same observation until
  something separates them.
- **`litestone mutate` mutates the schema with its IMPORTS INLINED.** `parse`
  does not follow an import, so reading the file's own bytes made every mutant of
  an importing schema die for a reason unrelated to the mutation — all 300 of
  basecamp's, and the command refused outright. `inlineImportsFromDisk` rather
  than `parseFile`, because the catalog is line-oriented and wants text; a
  fragment that cannot be read is NAMED, since its models are otherwise silently
  outside the run. What this buys is reach: the `@secret` and `@guarded` columns
  auth ships are only mutable once the fragment is in.
- **Mutation is code-only and quote-aware.** An attribute named inside a doc
  comment is prose; editing it produces a mutant identical in behavior, which
  survives everything. `example` reported four surviving `guarded-drop` mutants
  on a model with no `@guarded` field before this.
- **A UNIQUE collision is indistinguishable from a validator working.** Both are
  a throw on a write that should have been refused, so a constraint runner that
  counts any throw as *rejected* passes against a validator that does nothing.
  `verifyConstraints` checks for `ValidationError` by name and reports anything
  else as `error`; its first run on basecamp was 23 such rows, none about
  basecamp. Three separate guards keep them out — see the comment there before
  changing how it creates rows.
- **There is no `litestone restore`, and the asymmetry is the trap** (`ISSUES.md`
  `FJS-552`): the outbound side reads the schema and covers every database, while
  coming back is `litestream restore -o ./main.db <url>/<name>` typed once per
  SQLite database plus a directory copy for the jsonl/logger ones. A two-database
  app that restores `main` alone starts, and looks fine. `docs/replication.md`
  § Restoring is the checklist until the command exists.

## The two grids

**`test/verbs-rules.test.ts` asks whether every verb that can reach a row applies
every rule that guards it.** Twenty verbs × five row-reaching rules, ONE SCHEMA PER
RULE — a fixture carrying every rule at once has the gate refusing everything and
every other rule then reports as applied (`FJS-351`). Each rule is arranged the
same way: two rows, and the rule admits exactly one, so a verb that applies it
sees one and a verb that skips it sees two. **The verdict is never read off the
verb's own return value** — a count, a row, a boolean and a throw are four
vocabularies, and the first cut of this file scored `upsertMany` as passing
because `count && 2` is 2 for any non-zero count. Every cell asks the SYSTEM what
the caller could reach or move. Its first run found `FJS-720`.

**`test/matrix.test.ts` is where a CROSSING is answered.** 20 column kinds × 16
operations, one cell each, under one invariant — *no cell may silently return a
wrong answer*: supported, or refused **by name**. A missing cell fails rather than
being skipped, because every defect the crossing sweep found lived in an
intersection that each feature's own suite passed. A cell reading `200:ref` is
open FJS-200, asserted **still broken** — fix it and the matrix goes red telling
you to promote the cell, so a fix cannot leave the grid stale. A grid written
from belief asserts a wish. **What is still out is named in the file's own
header**, and the reasons differ: the relation kinds and `@from` need a second
model and therefore a second expectation table; `File` needs a `FileStorage`;
and `@version` is not a column kind at all — declaring one makes every update on
the model carry a revision, so it would change what every other row's `update`
cell means.

## Plugin hooks

```js
import { Plugin, PluginRunner, AccessDeniedError } from '@frontierjs/litestone'

class MyPlugin extends Plugin {
  onInit(schema, ctx) {}
  async onBeforeRead(model, args, ctx) {}
  async onBeforeCreate(model, args, ctx) {}
  async onBeforeUpdate(model, args, ctx) {}
  async onBeforeDelete(model, args, ctx) {}
  async onAfterRead(model, rows, ctx) {}
  async onAfterWrite(model, operation, result, ctx) {}   // operation: create|update|delete
  async onAfterDelete(model, rows, ctx) {}               // rows: all deleted rows
  buildReadFilter(model, ctx) { return { tenantId: ctx.auth?.tenantId } }
}
```

`ctx.tables` is how a hook reads another row: the calling flavor's own accessors,
so a read under `$setAuth` is graded by that principal's policies and one under
`asSystem()` is not. `onInit` runs before the tables are built and has none.

A `@@gate` lives in a plugin's `beforeRead`, so a read path that skips the plugin
runner skips the gate — `aggregate`, `groupBy` and `search` did (`FJS-262`).
