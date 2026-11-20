# Migrations

A migration is a plain SQL file, generated from the difference between your schema and the history so far. Files are what a deploy replays, so they are the only changes that reach production.

```lite
model Post {
  id    Int     @id
  title String
  slug  String?
}
```

```sh
litestone migrate dev add-posts    # create the file and apply it, with a drift check
litestone migrate apply            # in production: run every pending file, in order
```

The same steps are callable from code:

```js
import { parseFile } from '@frontierjs/litestone'
import { create, apply, migrationStatus } from '@frontierjs/litestone/migrations'

const parsed = parseFile('./schema.lite')
const made   = create(db, parsed, 'add-posts', './migrations')
await apply(db.$rawDbs.main, './migrations')

const status = migrationStatus(db.$rawDbs.main, './migrations')
if (!made.created || status.length !== 1 || status[0].state !== 'applied') throw new Error('the file should be written and applied')
```

## What else it can do

- `migrate create` writes a file without applying it, and `migrate status` lists applied, pending and modified
- `migrate check` asks whether the history builds the schema, with no database needed
- `migrate verify` confirms the live database matches the schema
- `migrate apply --backup` copies every database first, and is the only way back
- Three schemas are compared: declared (`schema.lite`), shadow (the files replayed) and live
- `migrate baseline` records files as applied without running them, for a database you already pushed
- `migrate accept <file>` lets a database start without a file recorded
- Files run in filename order, a 14-digit timestamp then a `snake_case` label
- A modified applied file blocks `apply`
- There is no `down`; rolling back means restoring the copy `--backup` took
- A destructive file carries a `DESTRUCTIVE` banner you must accept before it applies
- One folder per database in a multi-database schema

**In depth:** [Migrations § File migrations](../../migrations.md#file-migrations--production), [§ The three schemas](../../migrations.md#the-three-schemas-and-which-two-you-are-comparing), [§ There is no `down`](../../migrations.md#there-is-no-down--rolling-back-is-a-file-you-took-first)
