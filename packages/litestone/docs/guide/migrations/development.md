# In development

`autoMigrate` brings a live database up to the schema on every start, with no migration files. It is for development, where the database is disposable.

```lite
model Post {
  id    Int     @id
  title String
  slug  String?
}
```

```js
import { autoMigrate } from '@frontierjs/litestone'

const result = autoMigrate(db)
if (result.main.state !== 'in-sync') throw new Error(`expected in-sync, got ${result.main.state}`)
```

Add a field to the schema and the next call applies it; the result says `migrated` and how many statements ran.

## What else it can do

- `autoMigrate(db, null, { acceptDataLoss: true })` applies a change that drops a column
- A column that leaves the schema is refused as `blocked`, because a rename is a drop plus an add
- `{ pluralize, force, acceptResidue }` are the other options
- `litestone db push` is the same thing from a shell, and `--accept-data-loss` is its override
- Safe to call on every app start
- `db push` writes no file, so a deploy that replays migrations will not have the change
- Once there is somewhere to deploy to, switch to `litestone migrate dev`

**In depth:** [Migrations § autoMigrate](../../migrations.md#automigrate--development), [§ `db push` is prototyping only](../../migrations.md#db-push-is-prototyping-only)
