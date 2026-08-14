# Migrations

Litestone uses two migration modes: `autoMigrate` for development (like `prisma db push`) and file-based migrations for production (like `prisma migrate deploy`).

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
litestone migrate create add-users       # generate 20240101000001_add-users.sql
litestone migrate apply                  # apply all pending migrations in order
litestone migrate status                 # show applied / pending / modified
litestone migrate verify                 # confirm live db matches schema
```

```js
import { create, apply, status, verify } from '@frontierjs/litestone'

create(db, parseResult, 'add-users', './migrations')
apply(db, './migrations')
status(db, './migrations')
verify(db, parseResult, './migrations')
```

Migration files are plain SQL — review and edit before applying. Applied migrations are recorded in `_litestone_migrations`. Modified applied migrations show as `modified` in status and block `apply`.

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
own schema objects through one.** A change needing a rebuild — dropping a
column, changing a type, changing a foreign key, changing `@@strict` — drops the
table, which takes every trigger and index on it. Litestone's own are
regenerable from the schema and are restated afterwards. Yours exist only in the
live database, so there is nothing to restate them from: they are gone.

The generated migration says so, before the SQL that does it:

```sql
-- "note": this rebuild DROPS the table, which destroys:
--     trigger "note_audit"
--     index "note_title_idx"
-- Litestone did not create these and cannot restate them — recreate
-- them below, or in a JS migration that runs after this file.
```

`autoMigrate` applies the same SQL without showing it to you. If a table carries
schema objects you created, use file migrations for it, or run
`litestone migrate dry-run` first.

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
