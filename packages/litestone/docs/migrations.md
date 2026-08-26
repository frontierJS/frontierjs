# Migrations

Litestone uses two migration modes: `autoMigrate` for development (like `prisma db push`) and file-based migrations for production (like `prisma migrate deploy`). **Only the files reach a deploy** — see *The three schemas* below before mixing them.

## autoMigrate — development

Introspects the live database, diffs against a pristine rebuild of your schema, and applies changes directly:

```js
import { autoMigrate } from '@frontierjs/litestone'

autoMigrate(db)   // safe to call on every app start in dev
```

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

### What introspection cannot recover

SQLite does not store these, so `generateLiteSchema()` cannot reconstruct them. Add
them by hand after reviewing the generated output — the CLI emits a comment saying so.

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

Introspecting a database whose schema used any of the above and pushing the result
back is **lossy**: the access rules are silently gone, and the tables become readable
to anyone the gate previously excluded.

## Pristine diff — no shadow database

Unlike Prisma, Litestone does not create a shadow database. It builds a pristine in-memory database from your schema, introspects both, and diffs. This means:

- No extra database file created
- Works in read-only environments
- Safe to run in CI without write access to the filesystem

The diff covers tables, columns, indexes, foreign keys, STRICT, views and
triggers.

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

Litestone generates triggers for `@@fts` (index sync) and for an `updatedAt`
field, and indexes for `@@index` and `@@softDelete`. They are diffed like
anything else: one whose body no longer matches the schema is dropped and
recreated, and one the schema no longer declares is dropped.

**Only names Litestone generates are ever dropped:**

| Object  | Names Litestone owns                          |
| ------- | --------------------------------------------- |
| Trigger | `<table>_fts_*`, `<table>_updatedAt`          |
| Index   | `idx_<table>_<fields>`                        |

Anything else — a trigger or index you created in a JS migration or straight
against the database — is left alone by an ordinary migration.

Two consequences worth knowing:

An index you name `idx_<table>_something` **is** treated as Litestone's, because
that is the name it would generate for the same `@@index`. Name your own
differently.

**A table rebuild is destructive, and Litestone does not support carrying your
own schema objects through one — so it refuses the rebuild rather than doing
it.** A change needing a rebuild — dropping a column, changing a type, changing
a foreign key, changing `@@strict` — drops the table, which takes every trigger
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
