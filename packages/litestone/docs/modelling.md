# Modelling decisions

Reference tells you what an attribute does. This tells you which one to reach for.

Each entry is a question that comes up on most models, the test that settles it,
and what the wrong answer costs. Where the answer is decided by something in
Litestone's own emitter or client rather than by taste, the line is cited — those
are the ones that cannot be reasoned out from the schema language alone.

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
