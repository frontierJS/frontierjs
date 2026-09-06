# Migrations

Litestone uses two migration modes: `autoMigrate` for development (like `prisma db push`) and file-based migrations for production (like `prisma migrate deploy`). **Only the files reach a deploy** — see *The three schemas* below before mixing them.

## autoMigrate — development

Introspects the live database, diffs against a pristine rebuild of your schema, and applies changes directly:

```js
import { autoMigrate } from '@frontierjs/litestone'

autoMigrate(db)   // safe to call on every app start in dev
```

### It refuses a change that would destroy data

A column that leaves the schema takes its values with it, and `diffColumns` has
no rename detection — so `body` → `content` is a drop plus an add, the rebuild
copies only what the two tables share, and the values are gone. It used to
answer `state: 'migrated'` and say nothing; the row-count guard passed, because
it counts rows and not values (`FJS-641`).

```js
autoMigrate(db)                                   // → { main: { state: 'blocked', reason, dataLoss } }
autoMigrate(db, parsed, { acceptDataLoss: true }) // → { main: { state: 'migrated', ... } }
```

Any column drop blocks, not just the rename-shaped case: a plain drop was
exactly as silent, and a rename IS a drop. The hash is withheld, as it is for
the other blocked rules, so a schema left this way re-announces on every boot
rather than going quiet. One column out and one in of the same type is reported
as a probable rename, with the `ALTER TABLE … RENAME COLUMN` to use instead —
that guess changes the wording and never the decision.

On the CLI it is `litestone db push --accept-data-loss`. Without the flag the
command names the columns, prints `✗  DB not pushed` and **exits 1**.

**The file path still applies.** `litestone migrate create` writes the migration
with a boxed `DESTRUCTIVE` banner naming the columns whose values go — the file
is the review step, which is the whole difference between it and `autoMigrate`.

### A rebuild SQLite refuses is graded, not thrown

A rebuild copies surviving values through `INSERT … SELECT`, and a STRICT table
takes no TEXT into an INTEGER column — so a `String` → `Int` over a populated
table used to throw `cannot store TEXT value in INTEGER column post__new.body`
out of the migrator, at boot, naming a table that exists only inside the
migration it died in (`FJS-645`). It answers `state: 'failed'` now, with
SQLite's own sentence as the reason. The transaction had already rolled back
either way, so the database is untouched.

`failed` is a third state and is honestly distinct from `blocked`: one is a
pre-flight refusal, the other is SQLite declining what was attempted.

**It is a call and there is no `createClient({ autoMigrate: true })`.** That
spelling was silently ignored for as long as anyone reached for it — five of
this package's own test files carried it, and every one of them opens a fresh
database, where creating and migrating are the same thing, so none of them could
see it. `createClient` refuses an unknown option by name now (`FJS-579`), and
this one is answered rather than suggested at.

It stays a separate call because *migrate on open* has a hazard inside it: the
schema a process migrates TO is read later than the schema it is serving, so a
long-running app can move its own database ahead of its code on an ordinary
request, and the next boot inherits a migration it never ran (`FJS-566`).

No migration files generated. Handles: add/drop columns, add/drop tables, add/drop indexes, change defaults. Does not run data migrations — for those, use JS migration files.

```bash
litestone migrate dry-run   # preview what autoMigrate would do, no changes
```

## File migrations — production

```bash
litestone migrate dev [label]            # create + apply, with a drift check — the everyday verb
litestone migrate create add-users       # generate 20240101000001_add_users.sql
litestone migrate apply                  # apply all pending migrations in order
litestone migrate apply --backup         # …copying every database first
litestone migrate check                  # does the history build the schema? no database needed
litestone migrate baseline               # record the files as applied WITHOUT running them
litestone migrate status                 # show applied / pending / modified
litestone migrate verify                 # confirm live db matches schema
```

## The three schemas, and which two you are comparing

There are three, and most confusion about migrations is a comparison between
the wrong two.

| | is |
| --- | --- |
| **declared** | `schema.lite` — what the app says it needs |
| **shadow** | the migration files replayed into an empty database — what a deploy will build |
| **live** | the database in front of you |

`migrate create` and `migrate check` compare **declared ↔ shadow**: *what
migration is missing.* `migrate dev` and `migrate baseline` also compare
**shadow ↔ live**: *has somebody changed this database without writing a file.*

It used to be one comparison, declared ↔ live, doing both jobs. That is why a
database developed with `db push` — which matches the declaration by
construction — made `migrate create` answer *already in sync* at the exact
moment a migration was needed, while the deploy refused for want of one
([`FJS-D123`](../../../DECISIONS.md#fjs-d123)).

## `db push` is prototyping only

It writes tables directly and no file, so **a deploy replaying migrations will
not have the change**. That is fine before a project deploys and a trap after.
Use `migrate dev` once there is somewhere to deploy to.

If you have been pushing and need to catch up:

```bash
litestone migrate create catchup   # the delta, derived from the history
litestone migrate baseline         # record it as applied — your database already has it
```

`baseline` refuses when the database does not actually hold what those files
build, because one wrong baseline is a database that reports a complete history
and is missing a column. The other way out is to reset the development database
and let `migrate dev` build it, which is what Prisma does; a development
database is disposable, and this is the option that keeps the data.

```js
import { create, apply, status, verify } from '@frontierjs/litestone'

create(db, parseResult, 'add-users', './migrations')
apply(db, './migrations')
status(db, './migrations')
verify(db, parseResult, './migrations')
```

Migration files are plain SQL — review and edit before applying. Applied migrations are recorded in `_litestone_migrations`. Modified applied migrations show as `modified` in status and block `apply`.

### Filenames are the run order

`20240101000001_add_users.sql` — 14-digit timestamp, then a lower_snake label.
The files are applied in **filename order**, and nothing else records when one
was written, so the name is the ordering.

The clock is second-granular, which is not fine enough on its own: two
migrations created inside one second would either overwrite each other (same
label) or run in alphabetical order (different labels — `evolve` before
`initial`). So a new migration is named after the **last file already in the
directory**, not after the clock alone: if this second is not past the highest
stamp there, the stamp steps forward until it is. The timestamp still says
roughly when; it also says after what.

A file the pattern rejects is never applied, and is named rather than skipped
in silence — see `litestone migrate status`.

## There is no `down` — rolling back is a file you took first

Litestone generates no down migration and will not. A rebuild is a `DROP TABLE`,
so the inverse of *drop a column* is *invent the values it held*; the inverse of
a JS migration that rewrote every row is unwritable by anything but the person
who wrote it. What a generated down would reliably do is run, report success,
and leave a database that looks restored.

The reversal on offer is a copy of the database taken before the run:

```bash
litestone migrate apply --backup              # → ./backups/2026-08-16_120000/main.db
litestone migrate apply --backup=./snapshots  # explicit destination
```

Every SQLite database the schema declares is copied before the **first** one is
migrated — a copy taken as each database's turn comes round is a copy of a
half-migrated fleet — and if any copy fails, nothing is migrated at all. It is
off by default: copying a multi-gigabyte database on every deploy is a cost the
deploy should ask for.

To go back: stop the app, put each copy back over its database, and delete the
`-wal` and `-shm` files beside it. The command prints those paths after a
successful run.

Without `--backup`, apply names the pending files it cannot take back — one that
drops a table (a rebuild is one, so a dropped column counts) and every `.js`
migration, whose contents nothing here can read:

```
  !  no way back from this run without a copy of the database:
       20260816120000_drop_views.sql (drops 1 table)
     Re-run with --backup to take one first.
```

It warns and proceeds. Whether a schema change is reversible by *redeploying the
previous release* is the other question, and `litestone release --from <ref>`
is what answers it: an **expand** is taken back by redeploying the code, a
**contract** is the pivot after which only forward.

## JS migrations

For data migrations — backfills, transformations, seeding — create `.js` files alongside SQL files:

```js
// migrations/20240102000001_backfill-slugs.js
export async function up(db) {
  // db = full Litestone client — all ORM operations available
  const posts = await db.post.findMany({ where: { slug: null } })
  for (const post of posts) {
    await db.post.update({
      where: { id: post.id },
      data:  { slug: post.title.toLowerCase().replace(/\s+/g, '-') },
    })
  }
}
```

JS and SQL files run in filename order. Pass the client to `apply()`:

```js
await apply(rawDb, './migrations', client)
```

## Multi-database schemas

Litestone creates per-database subdirectories automatically:

```
migrations/
  main/
    20240101000001_initial.sql
  analytics/
    20240101000001_initial.sql
```

`litestone migrate create` and `apply` handle all databases in one command.

## Introspect an existing database

Generate a `.lite` schema from a live SQLite file:

```bash
litestone introspect ./existing.db --out schema.lite
```

Reconstructs column types, FK relations, indexes, `@@softDelete`, and enum CHECK constraints.

**The output parses, and reading it back is a fixed point.** That is asserted over
the corpus (`test/introspect-roundtrip.test.ts`) rather than assumed: for its whole
life this command wrote a `.lite` litestone could not read, behind six tests that
only matched substrings of the output (`FJS-594`). The generated file is also
order-stable — models and enums by name, relations by their foreign key — because
`sqlite_master` is in creation order, so a table a migration rebuilt moves to the
end and re-running the command otherwise produces a diff nobody can read.

`--report=<path>` writes what the reading could not carry as JSON, graded on the
same three tiers `litestone import` uses; `--strict` exits 1 on `changed`.

### What introspection cannot recover

SQLite does not store these, so `generateLiteSchema()` cannot reconstruct them. Add
them by hand after reviewing the generated output — the CLI says so at the top of
the file and once in the report.

- `@@allow` / `@@deny` row-level policies
- `@allow` field-level policies
- `@secret`, `@encrypted`, `@guarded`
- `@@log` / `@log`
- `@@gate`
- `@@fts`
- `@@db` (database assignment)
- `valueset` and `@values` — a binding is a rule about legal values, and SQLite records only the column

A `@generated` column IS recovered — as `@generated("…")`, with `"col"` written
back as `{col}`. An expression that cannot be spelled inside that string (one
holding a double-quoted literal) is handed over as a `/// FIXME` line instead of
being mangled into a plain, writable column.

Nor can the TYPE of a column whose storage class is shared. `DateTime` is stored as
TEXT and `Boolean` as INTEGER, so both come back as `String` and `Int` — faithful
to the file, thinner than the schema that wrote it. Reported where the DEFAULT is
evidence (a clock function, a 0 or a 1) and nowhere else: one row per TEXT column
is one row per column, and a report nobody reads is the same as no report.

A DEFAULT that is a SQL expression is recovered only where litestone wrote it —
`uuid()` and `now()` — because those are the two `ddl.js` emits. Any other is
handed over rather than quoted: emitted as `@default("<its text>")` it stops being
an expression and becomes a string LITERAL, so every row written afterwards gets
the SQL as its value.

### Partial indexes, and why the two halves differ

An index over SOME rows is not the same index as one over all of them, and what
that costs depends on whether it is UNIQUE.

**A partial unique index is handed over, never emitted.**
`CREATE UNIQUE INDEX u ON note (email) WHERE deleted_at IS NULL` is uniqueness
among LIVE rows, and `.lite` has no way to say that — `@unique` would mean
uniqueness among ALL rows, which is a **stronger** constraint than the database
it came from, and one that then refuses writes the source accepted. So it comes
back as a `// FIXME` naming the predicate.

**A partial plain index is emitted whole where it can be**, since dropping a
predicate there only widens the index — the same rows are answered by a larger
structure:

```prisma
@@index([kind], where: archivedAt == null)
@@index([kind, email], where: live == true)
```

Where the predicate is not one `@@index(where:)` accepts, the plain index is
emitted with a `// NOTE` saying what was dropped. Where the model has
`@@softDelete` and the predicate is exactly `deleted_at IS NULL`, it comes back
as a plain `@@index` — litestone adds that clause to every index on such a model
itself, and declaring it as well is refused.

Two things a database can hold that a schema cannot, both handed over by name:
an index over an **expression** (`lower(email)`), and a **second index over the
same column list** — litestone names an index for its columns, so only the first
can be declared.

Introspecting a database whose schema used any of the above and pushing the result
back is **lossy**: the access rules are silently gone, and the tables become readable
to anyone the gate previously excluded.

## Pristine diff — no shadow database

Unlike Prisma, Litestone does not create a shadow database. It builds a pristine in-memory database from your schema, introspects both, and diffs. This means:

- No extra database file created
- Works in read-only environments
- Safe to run in CI without write access to the filesystem

The diff covers tables, columns, indexes, foreign keys, STRICT, CHECKs, table
uniques, views and triggers.

### …and what it does not cover, which it now tells you

That list is enumerated, and six issues of this package's history are one
dimension arriving in the DDL emitter and not in the differ — each one reading
as *schema is in sync* over a database that is not the declared one. So once
the enumeration has had its say, the two `sqlite_master`s are compared whole
and the leftovers are named:

```
[litestone] Database "main" is in sync on every dimension the migration differ
            reads, and 1 object(s) still differ:
              table account
                declared: CREATE TABLE "account"(…,"email" TEXT NOT NULL UNIQUE)STRICT
                live    : CREATE TABLE "account"(…,"email" TEXT NOT NULL UNIQUE COLLATE NOCASE)STRICT
```

**Nothing is applied and nothing is blocked.** There are two readings and
litestone cannot tell them apart:

- **The schema cannot express what the database has.** `litestone introspect`
  is the adoption door, and a real database has a collation on its email
  column, a `WITHOUT ROWID` table, or an index somebody wrote by hand. Say so
  with `autoMigrate(db, null, { acceptResidue: true })`, which records the
  acceptance rather than filtering the output.
- **The differ is missing a dimension**, which is a defect in litestone — the
  first thing this found was one (`FJS-718`: a foreign key's `ON UPDATE` was
  emitted, parsed, introspected and then dropped by the comparison).

It is not part of `hasChanges`: there is nothing here that could write a
migration for a dimension it cannot see, and a change that never resolves would
migrate on every boot for ever. The residue is recorded beside the DDL hash, so
the startup fast path re-announces it for the price of one `SELECT`.

### Adding a column, and the two ways it cannot be done

`ALTER TABLE … ADD COLUMN` is the cheap path and SQLite narrows it twice. Both
narrowings are its rules rather than choices made here, and both used to be
found at the worst possible moment.

| The column | What happens |
| --- | --- |
| optional, or a CONSTANT default | `ALTER TABLE … ADD COLUMN` |
| an EXPRESSION default — `@default(now())`, `@default(uuid())` where it compiles to SQL | a table rebuild. SQLite takes an expression default in `CREATE TABLE` and refuses one in an `ALTER`, where it wants a constant |
| `NOT NULL` with no default | **blocked**. There is no value to give the rows that already exist, and SQLite refuses the ALTER outright |

**An expression default therefore costs a rebuild**, which is not free: a rebuild
is refused where the app made its own index or trigger over the table (§ *Schema
objects Litestone did not create*), so a table carrying one has to have it moved
into the schema first. The alternative was worse — the ALTER was emitted anyway
and threw `near "(": syntax error` out of `autoMigrate`, at the line an app
calls on first open, naming no column and no table ([FJS-605](../../../ISSUES.md#fjs-605)).

**A blocked column blocks whether or not the table has rows**, and that is
deliberate. Migrating an empty table and refusing a populated one would migrate
cleanly on every developer's machine and block at the deploy, which is the one
place nobody wants to meet it for the first time. `litestone release` grades the
same change as a **contract** and hands back the plan — expand, backfill,
contract — for the same reason.

**It is announced as well as returned.** `autoMigrate` answers
`{ state: 'blocked', reason }` and prints it. It used to answer
`{ state: 'migrated', applied: 0 }` on the ALTER path, with the reason visible
only inside a SQL string the caller usually discards: the application then ran
against a table missing a column its own schema declares, every write of that
column was stripped by mass-assignment protection, and a required field read
back `undefined` with nothing anywhere saying why
([FJS-604](../../../ISSUES.md#fjs-604)).

### Uniqueness the table declares itself

`@unique` on a column and `@@unique([a, b])` are both **table constraints** —
they are emitted inside `CREATE TABLE`, not as a `CREATE UNIQUE INDEX`. SQLite
builds an implicit index for each, and an implicit index has no `sql` in
`sqlite_master`, which is what every index reader here filters on. So for a long
time none of this was diffed at all:

| Change | Was | Is |
| --- | --- | --- |
| add a `@@unique` or a `@unique` | **nothing migrated** — the schema declared a constraint the table did not enforce, and the duplicate landed | a table rebuild |
| remove one | **nothing migrated** — the table went on refusing writes the schema allows | a table rebuild |
| reorder a composite one | **nothing migrated** | a table rebuild |
| the column order of a composite primary key (`@@id([a, b])`) | **nothing migrated** | a table rebuild |

The first two are correctness: `UniqueConflictError` and `SoftDeletedUniqueError`
are Litestone's words for a constraint the *database* enforces, so a constraint
that never reached the database is one that never fires. The last two are the
performance fact [FJS-592](../../../ISSUES.md#fjs-592) settled for `@@index`, one
constraint kind along — an implicit index is prefix-matched like any other, so
`(orgId, createdAt)` answers `WHERE orgId = ?` and the swap does not.

**The cost is a rebuild and there is no cheaper path**: no `ALTER` reaches a
table constraint. Which is why this shipped after the `@@index` half rather than
with it — that one is a `DROP INDEX` and a `CREATE INDEX`
([FJS-596](../../../ISSUES.md#fjs-596)).

Two things follow from reading it off `PRAGMA index_list` rather than out of the
`CREATE` text:

**Moving between the two spellings migrates nothing.** `email String @unique` and
`@@unique([email])` build the same implicit index, so swapping one for the other
is not a change to the database and is not reported as one.

**A `CREATE UNIQUE INDEX` you made yourself is not read here.** Only `origin` `u`
and `pk` are — the constraint-borne ones. An explicit index is `origin` `c` and
belongs to the index diff, which leaves an index Litestone did not name alone
(§ *Schema objects Litestone did not create*).

**A rebuild that adds uniqueness fails if the rows already violate it.** The copy
is an ordinary `INSERT … SELECT`, so SQLite refuses it and the whole migration
rolls back — loud, and inside the transaction. Clear the duplicates first.

### `@generated` columns

A generated column is not in `PRAGMA table_info` at all, so this diff reads
`table_xinfo`, and its expression is read off the table's own `CREATE`
statement — the only place SQLite keeps it. What follows is SQLite's, not a
choice made here:

| Change | What is emitted |
| --- | --- |
| add a VIRTUAL one | `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (…) VIRTUAL` |
| add a STORED one | a table rebuild — SQLite answers `cannot add a STORED column` on a table that has rows |
| change the expression, or the storage | a table rebuild — no `ALTER` reaches either |
| drop one | a table rebuild, like any other dropped column |

A rebuild never copies a generated column: `INSERT` naming one is refused
(`cannot INSERT into generated column`), and there is nothing to copy — the
rebuilt table computes it from the columns that were.

The one thing that cannot be diffed is an expression this cannot read back. It
is reported as *unchanged* rather than guessed at, so an exotic expression costs
a migration you write by hand, not a rebuild on every run.

## Schema objects Litestone did not create

Litestone generates triggers for `@@fts` (index sync), and indexes for `@@index`
and `@@softDelete`. They are diffed like anything else: one whose body no longer
matches the schema is dropped and recreated, and one the schema no longer
declares is dropped.

`<table>_updatedAt` is in that second class as of `FJS-531` — the client stamps
the column itself now, so an existing database is migrated by one
`DROP TRIGGER IF EXISTS` with no table rebuild. The name stays on the owned list
below, because it is what lets the migration take it away.

**Only names Litestone generates are ever dropped:**

| Object  | Names Litestone owns                          |
| ------- | --------------------------------------------- |
| Trigger | `<table>_fts_*`, `<table>_updatedAt`          |
| Index   | `idx_<table>_<fields>`, `uniq_<table>_<fields>` |

Anything else — a trigger or index you created in a JS migration or straight
against the database — is left alone by an ordinary migration.

**Two prefixes, because an index and a constraint can be about the same
columns.** `@@index([a])` is `idx_<table>_a` and `@@unique([a], where: …)` is
`uniq_<table>_a` — a lookup and *at most one row where the predicate holds* are
different things and a model may want both, which one derivation made
undeclarable.

Three consequences worth knowing:

An index you name `idx_<table>_something` **is** treated as Litestone's, because
that is the name it would generate for the same `@@index`. Name your own
differently. The same goes for `uniq_<table>_something`.

**An index whose derived name changes is renamed** — one `DROP INDEX` and one
`CREATE INDEX`, no rebuild. Litestone matches an index by its SHAPE (columns,
sorts, uniqueness, predicate), so a matched pair whose names differ is one this
build derives differently than the build that wrote the database. Your own index
of the same shape is not touched: the rename only applies where the live name is
one Litestone owns.

**A table rebuild is destructive, and Litestone does not support carrying your
own schema objects through one — so it refuses the rebuild rather than doing
it.** A change needing a rebuild — dropping a column, changing a type, changing
a foreign key, changing `@@noStrict` — drops the table, which takes every trigger
and index on it. Litestone's own are regenerable from the schema and are
restated afterwards. Yours exist only in the live database, so there is nothing
to restate them from.

Naming them in a comment above the SQL was the earlier answer, and it was the
wrong one for the reader who matters: somebody applying a generated migration
without reading it. The rebuild is emitted **commented out** instead, the same
shape an un-defaultable new column gets:

```sql
-- "note": rebuild BLOCKED — it DROPS the table, which destroys:
--     trigger "note_audit"
--     index "note_title_idx"
-- Litestone did not create these and cannot restate them. Fix one of:
--   • recreate each one below the rebuild, then uncomment it
--   • move it into the schema, where litestone regenerates it
--   • if it is no longer wanted, drop it by hand and uncomment
-- … the whole rebuild, commented …
```

`autoMigrate` reports `blocked` with the same list and writes no hash, so it
surfaces on every startup until the schema or the database says what should
happen.

Re-emitting a captured trigger verbatim is the option not taken: its body may
name a column the rebuild drops, so it would restate SQL that fails at `CREATE`
or, worse, at the next write.

### A rebuild counts its own rows before it drops the original

A rebuild is `INSERT INTO t__new SELECT … FROM t` followed by `DROP TABLE t`, and
a copy that read fewer rows than the original holds is an error to nobody —
SQLite inserted what it was asked for, and the runner saw a statement return. One
statement later those rows are gone and the migration reports success.

So the generated rebuild compares the two counts in between:

```sql
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of post lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "post__new") = (SELECT count(*) FROM "post") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";
```

SQLite has no assertion — `RAISE()` is legal only inside a trigger body — so the
comparison is a CHECK, and the constraint's **name is the message**:

```
error: CHECK constraint failed: rebuild of post lost rows
```

It aborts inside the migration's transaction, so the original table is still
there afterwards. The commonest way to reach it is by hand-editing the copy step
of a generated file, which is a thing these files invite. It is also emitted
when there is nothing to copy at all — a rebuild sharing no column name with the
old table used to empty it under a comment reading *nothing to copy*.

**A view is not in that class and does survive.** A view is a stored `SELECT`
with no state, so Litestone drops every view over the table before the rebuild
and puts it back verbatim afterwards — one you declared in the schema and one
you created by hand alike. A view the schema redefines in the same migration
gets its new body instead.

The one thing a rebuild cannot survive is a view that reads a column the rebuild
removes. SQLite does not resolve a view body at `CREATE` time, so such a view
comes back without complaint and fails in whatever reads it — so each restored
view is read once inside the migration's transaction, and one the schema change
invalidated refuses the migration:

```
error: no such column: scratch
```

Fix the view body in the same change. Note the limit: a body written
`SELECT "scratch"` with the column **double-quoted** is not caught, because
SQLite resolves an unknown double-quoted identifier as a string literal rather
than an error — the view then returns the string `'scratch'` for every row.
Quote identifiers in a view body only when you must.
