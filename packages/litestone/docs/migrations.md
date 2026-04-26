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

## Pristine diff — no shadow database

Unlike Prisma, Litestone does not create a shadow database. It builds a pristine in-memory database from your schema, introspects both, and diffs. This means:

- No extra database file created
- Works in read-only environments
- Safe to run in CI without write access to the filesystem
