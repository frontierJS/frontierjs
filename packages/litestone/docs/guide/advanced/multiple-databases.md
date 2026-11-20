# Multiple databases

`database` blocks route models to separate SQLite files, append-only JSONL logs or an audit trail. One `createClient` call opens them all, and a model's `@@db` picks its home.

```lite
database main      { path "./app.db" }
database analytics { path "./analytics.db" }

model User {
  id    Int    @id
  email String
}

model PageView {
  id   Int    @id
  path String
  @@db(analytics)
}
```

```js
const db = await createClient({ path: './schema.lite' })

await db.user.create({ data: { email: 'a@example.com' } })       // -> app.db
await db.pageView.create({ data: { path: '/' } })                // -> analytics.db

const { existsSync } = await import('node:fs')
if (!existsSync('./app.db') || !existsSync('./analytics.db')) throw new Error('expected one file per database')
if ((await db.pageView.count()) !== 1) throw new Error('expected the view in analytics')
await db.$close()
```

Queries route by model with no extra code, and a `$transaction` rolls back every database it wrote to.

## What else it can do

- `driver jsonl` is an append-only log with no update, delete or migration
- `driver trail` receives `@@trail` write entries as a queryable audit model
- `retention 30d` sweeps old rows, and `@@retention(90d, from: capturedAt)` sets a window per model
- `path env("VAR", "./default")` reads the location from the environment
- `$attach` and `$detach` add a file for raw SQL across databases
- `@@external` marks a table or view litestone queries but does not create
- Migrations live in one subdirectory per database, and one command applies them all
- Each file commits on its own, so a commit that fails part way names what committed

**In depth:** [Multi-database § Database blocks](../../multi-database.md#database-blocks), [§ Assigning models](../../multi-database.md#assigning-models), [§ Drivers](../../multi-database.md#drivers), [§ Transactions across databases](../../multi-database.md#transactions-across-databases), [§ Retention](../../multi-database.md#retention), [Migrations § Multi-database schemas](../../migrations.md#multi-database-schemas)
