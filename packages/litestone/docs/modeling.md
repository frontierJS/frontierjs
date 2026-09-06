# Modeling decisions

Reference tells you what an attribute does. This tells you which one to reach for.

Each entry is a question that comes up on most models, the test that settles it,
and what the wrong answer costs. Where the answer is decided by something in
Litestone's own emitter or client rather than by taste, the line is cited — those
are the ones that cannot be reasoned out from the schema language alone.

## Which feature makes this field?

Eight attributes and a plain declaration put a value on a model, and choosing
between them is not a question about what the value *means*. It is two
mechanical questions — **is there a column**, and **who computes it, and
when** — and everything downstream falls out of those two: whether a filter may
name it, whether a generated form offers a control for it, whether a migration
ever touches it.

|                       | column | caller may write | filter | sort  | `groupBy` | computed by |
| --------------------- | ------ | ---------------- | ------ | ----- | --------- | ----------- |
| plain field           | yes    | yes              | yes    | yes   | yes       | the caller |
| `@default(…)`         | yes    | yes — a stated value wins | yes | yes | yes  | SQLite, on insert |
| `@system`             | yes    | no — the app names it on the write | yes | yes | yes | the application |
| `@immutable`          | yes    | **at create only** — every later write is refused, `asSystem()` included | yes | yes | yes | the caller, once |
| `@guarded`            | yes    | `asSystem()` only | `asSystem()` only | `asSystem()` only | no | the application |
| `@generated("…")` / ``@generated(`…`)`` | yes | no        | yes    | yes   | yes       | SQLite — per read (`VIRTUAL`) or per write (`STORED`) |
| `@derived(expr)`      | no     | no               | yes    | yes   | yes       | SQLite, in the SELECT |
| `@from(Model, op)`    | no     | no               | yes    | yes   | **no**    | SQLite, a correlated subquery |
| `@computed`           | no     | no               | **no** | **no** | **no**   | JS, after the row is read |
| `@transient`          | no     | yes — and nothing stores it | **no** | **no** | **no** | nobody; it is input |

Measured against a real client on one model carrying every kind at once, not
read off the emitter. Every *no* in the write column is a refusal that names the
attribute and says why — `@from` was the one exception, accepted and silently
dropped, until [FJS-395](../../../ISSUES.md#fjs-395).

**`@guarded` refuses the NAME as well as the value**, which is what the two
`asSystem()` cells in the filter and sort columns mean. Until
[FJS-393](../../../ISSUES.md#fjs-393) a caller who could not read the column
could still compare it, which recovers it one `startsWith` at a time, and could
sort by it, which leaks the ordering of every row at once. The refusal follows
the grammar across relations, so a relation filter, a relation `orderBy` and a
nested `include` are refused too. **A field-level `@allow('read', …)` still has
this hole** ([FJS-442](../../../ISSUES.md#fjs-442)) — a predicate is not a set,
and the two do not have the same fix — so a value that must not be recoverable
is `@guarded`.

### The path

**Does the caller supply the value?** Then it is a plain field, and the only
follow-up is whether the API also accepts a key that is *not* stored — a
password to hash, a coupon to redeem, a confirmation checkbox. That is
`@transient`: validated with the model's own rules, lifted off the payload
before the write, and refused by name in a `where` because there is no column
to bind.

**Does the application supply it?** Then the question is who may read it back.
`@system` is readable by anyone and written only by the app naming the column
(`db.order.update({ …, system: ['trackingCode'] })`); `@guarded` is readable
and writable only through `asSystem()`. They are not tiers of the same thing —
`@system` is for a value a screen must show and a caller must not forge, and
`@guarded` is for one nothing outside the app has any business seeing.

**Does it stop being writable once it exists?** Then it is `@immutable`, and it
is the only entry in the table above whose answer changes with the row's age
rather than with who is asking. A document is the case — an invoice's number,
the instant it was issued, the total it was issued for — where a correction is a
new row that supersedes the old one and never an edit.

Three things about it are worth knowing before reaching for it, and each is a
consequence of the same fact, that **nothing in this language can see the stored
row beside the incoming one**:

- **It refuses the KEY, not the value.** An update naming the column is refused
  whether or not the number differs, so a form that fetches a row and sends it
  back whole must drop the column rather than round-trip it. Sierra's write
  pipeline already does — `@immutable` reaches the client as `readOnly` **in the
  update schema alone**, so a generated create form still offers the box.
- **`asSystem()` does not drop it.** It sits with `@check`, `@@check` and
  `@@arc` rather than with the gate, the row policies and `@guarded`. That is
  the point of it: a renewal job and a payment settler both run as system, so a
  rule they may drop is a rule absent from every caller that actually writes an
  invoice. A raw `UPDATE` still bypasses it, exactly as it bypasses a `@check`.
- **It says nothing about DELETE**, and nothing about the row as a whole. To
  freeze a row when it reaches a state, freeze its columns and let
  `@@transitions` own the state column — which is the shape the ruling took
  rather than a row-level attribute, because a document that may not move is not
  a document, it is a log line.

Refused at parse beside `@version` and `@updatedAt`, which the engine writes on
every update: a column cannot be both. See [`FJS-D162`](../../../DECISIONS.md#fjs-d162).

### `@seals` — the moment a row becomes a document

`@immutable` freezes at CREATE, and that is the wrong moment for most real
documents: an invoice is assembled line by line and becomes a statement when it
is issued. Written with `@immutable` alone the only way to build one is to write
it whole, which is why the shape kept appearing without a `draft` state at all.

`@seals` on a move says the row becomes a document there, and `@sealed` on a
hasMany relation says which children it is made of:

```lite
model Invoice {
  id     Int      @id
  state  DocState @default(draft)
  number String   @immutable
  total  Int      @immutable
  lines  InvoiceLine[] @sealed      // ← which children the document is made of
  payments Payment[]                // ← and which go on arriving after it

  @@transitions(state,
    issue:  draft  -> issued @seals @gate(5),   // ← when it seals
    settle: issued -> paid @system,
    void:   issued -> void)
}
```

Four things follow, and each of them is the reason it is spelled this way:

- **The sealed set is COMPUTED, never listed.** It is everything reachable from
  a `@seals` move's target, so `paid` and `void` are sealed without anything
  restating them, and a move added later to the tail of the machine is sealed by
  arriving. A machine that comes back OUT of a sealed state is refused at parse:
  a document that unseals is not a document.
- **`@immutable` on a sealing model means *frozen at the seal*.** Its columns are
  ordinary while the row is a draft and refused afterwards. Scoped by the
  declaration — a model with no `@seals` move keeps the create-time meaning
  exactly — and the refusal moves out of the payload into the WHERE, because the
  answer is now in the ROW. So it reaches the client as
  `x-litestone-kind: 'immutable-until-seal'` with the state column and the sealed
  set beside it, rather than as `readOnly`: no schema can answer it, and a form
  resolves it off the record it is editing.
- **`@sealed` is explicit and is never inferred.** Every child relation on a
  sealing model looks sealable and they are not — a payment against an issued
  invoice is exactly the row that must keep arriving.
- **`asSystem()` does not lift it**, exactly as it does not lift `@immutable`.
  This is the one place it parts company with `@@transitions`, which `asSystem()`
  bypasses entirely: a gate is about who is asking and a seal is about what the
  row IS.
- **It says nothing about deleting the document itself**, for the reason
  `@immutable` says nothing about DELETE: whether an issued invoice may be
  removed is a question about who may remove it, which is `@@gate`'s. `@sealed`
  governs the children a document is MADE of, and the sealing row's own
  existence is the gate's — `@@gate("1.8.8.8")` on the model is what says *and
  nobody deletes one*.

A refused write raises `SealedDocumentError` — a 409, `retryable: false` — which
names the document, the state it was found at and the relation or the columns.
The guard rides the WHERE like the transition compare-and-swap and the `@version`
check, so a refusal is zero rows changed; the sentence comes from a follow-up
read that runs only on that path, and only after the move and the revision have
each had their say.

Both halves are in `db/access.snapshot.md` (a **Seals** column beside **Made
by**, and the relation list under it) and in the release surface, where gaining
either is a **contract**: an N-1 release that writes a line onto an issued
invoice stops working the moment the deploy lands.

**Is it derived from other values?** Then the deciding question is **where
SQLite has to be able to see it**, and the answers are genuinely different
tools rather than tastes:

- **`@computed`** — a JS function over the fetched row. SQLite has never heard
  of it, so it **cannot be filtered, sorted, grouped or aggregated by**, and
  `orderBy` says so rather than answering the right rows in the wrong order
  ([sorting.md](sorting.md)). Reach for it when the derivation needs JavaScript:
  formatting, a lookup table, anything with a branch SQL would make unreadable.
### What the parser refuses, and what `advise` merely reports

Two owners, and the line between them is whether the schema can be built at all.

The **parser** refuses what cannot be expressed. Three of these are derived from
one question — *what does the column physically hold* — rather than ruled
attribute by attribute:

| written | what happens without the rule |
| --- | --- |
| `@unique` / `@@unique` / `@@index` over `@computed`, `@derived` or `@from` | the constraint vanishes, or `@@unique` emits `UNIQUE ("c")` over a column that is not emitted and SQLite refuses the whole table at boot |
| `@default(12.99)` on `@scale(2)` or `@money` | the column is an INTEGER of minor units, so `DEFAULT 12.99` is written into the DDL and the first row that takes it is refused |
| `@relation` between models in two `database` blocks | a foreign key names a table and a table lives in one file, so every create throws `no such table` |

`@generated` is deliberately not in the first row: it is a real column and takes
a constraint like any other.

**`litestone advise`** is the other half — what is legal and *wrong*. Its own
contract is that every rule in it parses, so `@@fts` over an `@encrypted` column
(the index holds ciphertext; `search()` can never match a word) is reported
there and not refused here.

- **`@derived(expr)`** — a *predicate or a bucket*, in the `@@allow` expression
  language, emitted into the SELECT. Filterable and sortable, because it is SQL.
  The language is comparisons, `and`/`or`/`not`, a ternary, `now()` and
  literals, and that is all: `@derived(qty * price)` does not parse, and neither
  does any SQL function call (`compileDerived`, `src/core/policy.js:188`). It is
  for *is this row overdue*, not *what is this row's total*.
- **`@generated("sql expr")`** — a real column, `GENERATED ALWAYS AS`, so it
  takes arbitrary SQL and is the answer whenever the derivation is a **value**
  rather than a question: `@generated("{qty} * {price}")`. `{field}` expands to
  `"field"`, so no quote-escaping. `VIRTUAL` by default, `@generated("…",
  stored)` to materialise it; a `@@index` on either works.
  **In backticks it is a template rather than SQL** —
  ``@generated(`{firstName} {lastName}`)`` — which is the form to reach for
  whenever the value is a **string joined out of columns**, because the SQL
  version of that one is not merely longer but wrong: `coalesce(a,'') || ' ' ||
  coalesce(b,'')` leaves `Ada  Lovelace` where a middle name is missing. A
  template compiles to `concat_ws`, which drops a NULL and its separator
  together ([schema.md](schema.md)).
- **`@from(Model, count: true)`** — the derivation crosses a relation, which
  none of the other three can do. Filterable and sortable, and **not
  groupable**: it is a correlated subquery aliased into the SELECT, not a
  column, so aggregate the target model instead.

The two that get confused are `@derived` and `@generated`, and the test is one
sentence: **a question about the row is `@derived`, a value built from the row
is `@generated`.** `overdue Boolean @derived(dueAt < now() && completedAt ==
null)` is the first; `fullName`, `total`, `slugBase` are all the second, and
the language `@derived` speaks cannot express any of them — it has comparisons
and a ternary, and no arithmetic, no concatenation and no function calls. Of
the second group, the ones that are **joined strings** take `@generated`'s
backtick form and the rest take its SQL one.

### Where the matrix runs out

**`@computed` is the only one that costs a runtime argument.** It needs a
`computed:` map passed to `createClient`, so it is the one derivation that can
be missing at the call site — a client built without the map answers rows with
the field absent and nothing says so.

**A `@computed` field the `select` did not name is not computed at all**, and a
bare function widens the SELECT to `*` for every field beside it. Declaring
`needs: ['first', 'last']` narrows the fetch and hands the function a row
carrying only those names, which throws on any other read — that guard is what
makes the narrow fetch safe.

**`@updatedAt` is stamped twice over, and that is the design.** The attribute
decides which fields are stamped — any name, however many of them
([FJS-394](../../../ISSUES.md#fjs-394)); a field called `updatedAt` is stamped
with no attribute at all, which is a fallback for the schemas written before
that and not a second way to ask. The client names those columns in its own
`UPDATE`, so the row a write hands back is the row in the database. The DDL
trigger is the floor beneath it, for the writes that never come through the
client — raw SQL and a migration — and it stands down for a statement that
already named the column. Both spellings write the same expression, so a row
stamped either way sorts with the other. Before this the trigger was the only
half, and `RETURNING` is evaluated before an `AFTER` trigger fires, so every
write answered the previous timestamp
([FJS-396](../../../ISSUES.md#fjs-396)).

**An `@@external` model stamps nothing.** Litestone emits no DDL for that
table, so there is no trigger, and the client will not write a column it does
not own. `@updatedAt` there is declared and inert.

**A `@default(…)` is not a lock.** A caller naming the column wins, `now()`
included, which is what separates it from `@system` — if the point is that
nobody outside the app sets this value, the default is the wrong attribute.

**Nothing in this table is a substitute for `@@allow`.** `@guarded` and
`@system` decide *which columns* a context may touch; who may see a *row* is a
policy, and a field attribute cannot express it.

## Should this id be a uuid or an `Int`?

**`Int @id` with no default is SQLite's rowid alias** (`src/core/client.js:4244`) —
that column is not stored as a column at all, it is the table's own b-tree key.
A `String @id @default(uuid())` costs 36 bytes of TEXT per row *and* a second
index, because a non-INTEGER primary key cannot be the rowid, so SQLite keeps a
hidden rowid alongside a unique index on the uuid.

A uuid earns that back in three cases, and only these:

- **The id appears in a URL.** Sequential ids leak row counts and invite
  enumeration of rows a policy would otherwise have to refuse one at a time.
- **The id is generated before the insert.** A client that builds a record
  offline, or a caller that needs the id to write a second row in the same
  batch, cannot wait for the database to choose.
- **The id crosses a database boundary.** Merge, sync, sharding, or a
  `strategy database` tenant whose rows may one day be pooled — two tables
  that both counted from 1 collide.

None of those is about how important the model is, which is the intuition to
distrust. A join table nothing addresses by id takes the free one even when it
sits between two models that both hold uuids.

The test that decides it: **does anything outside this table ever hold this
value?** If every read is by some other key, the id is bookkeeping.

One consequence to remember either way: **SQLite reuses a rowid after a delete.**
Never build an idempotency key, an external reference, or an occurrence key from
one — `@frontierjs/toolbelt/history` exists for that.

## Can the natural key be the primary key?

**It works, and it is still usually not what you want.**

Two fields carrying `@id` produce a correct composite `PRIMARY KEY (a, b)` in the
DDL (`src/core/ddl.js:217`), and the client addresses it properly: `findUnique`
with the full key answers one row, `findUnique` with a partial key **throws**
`returned more than one row` rather than answering the first match, and
`update`/`delete` reach exactly the intended row. Measured, not assumed.

What it costs is narrower than the shape suggests, and sharper. A `@from`
derived field across a relation into a composite key correlates on the FIRST key
column and drops the rest, so the aggregate counts every row sharing that column
— a plausible number, no error, a count of real rows, answering a question
nobody asked (`FJS-377`).

So the rule is not *composite keys are unsupported*. It is:

- A model nothing aggregates over and nothing relates into may key on its
  natural columns.
- The moment a `@from` points at it, or is likely to, take the surrogate and put
  the natural key in `@@unique`.

The surrogate costs one rowid-alias column, which is free (above). The composite
key costs a class of silently wrong reads. That asymmetry is the whole argument,
and it will survive `FJS-377` being fixed — a key that every future relation has
to carry in two columns is a tax on every model that points at it.

## Should this be a `Json` array of ids, or a join table?

A `Json` column holding ids is a foreign key with no constraint: nothing can
tell a live id from a typo, and deleting the target leaves every holder silently
pointing at nothing. `packages/basecamp/db/schema.lite:1503` records one that
had to be reversed — `AlertRule.channels` became `AlertRuleChannel`, because a
dead channel id meant an alert was never delivered and nobody was told.

The test is not *is this a foreign key* — it is: **does a dangling id cause
silence in something that matters?**

- If a stale id means work does not happen, a message is not sent, a permission
  is not applied — join table. The constraint is the point.
- If a stale id degrades to slightly worse output that the reader filters out,
  the blob is honest and cheaper. A learned ordering, a list of dismissed hints,
  a cache of recent picks.

Where the blob wins, the filter at the read site is not defensive noise. It is
standing in for the constraint that was declined, and it belongs in the same
commit.

The blob has a second cost worth pricing before choosing it: it is written
whole, so two writers touching different keys clobber each other, and it cannot
be queried into — no aggregate over it, no join, no index. If either of those
is wanted later, that is the migration.
